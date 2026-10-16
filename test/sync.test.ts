import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { MandarinDB } from '../src/db/db.ts';
import type { Card, Deck, LogEntry, Review } from '../src/db/types.ts';
import { SyncEngine } from '../src/sync/engine.ts';
import { incomingWins, type SyncedKind } from '../src/sync/merge.ts';
import type { Cursor, PullResult, RemoteDoc, RemoteStore } from '../src/sync/remote.ts';

/**
 * In-memory stand-in for Firestore. Like Firestore, every document written in
 * one batch shares one commit stamp, and a stamp only ever increases.
 */
class MemoryRemote implements RemoteStore {
  private stamp = 0;
  readonly collections = new Map<SyncedKind, Map<string, { data: Record<string, unknown>; stamp: number }>>();
  pushes = 0;
  /** Test hook: runs after a push lands, to simulate concurrent activity. */
  afterPush: (() => Promise<void>) | null = null;

  private collection(kind: SyncedKind) {
    let c = this.collections.get(kind);
    if (!c) this.collections.set(kind, (c = new Map()));
    return c;
  }

  async push(kind: SyncedKind, docs: RemoteDoc[]): Promise<void> {
    this.pushes++;
    const stamp = ++this.stamp;
    for (const doc of docs) this.collection(kind).set(doc.id, { data: structuredClone(doc.data), stamp });
    if (this.afterPush) {
      const hook = this.afterPush;
      this.afterPush = null;
      await hook();
    }
  }

  async pullSince(kind: SyncedKind, cursor: Cursor): Promise<PullResult> {
    const from = cursor?.seconds ?? 0;
    const docs: RemoteDoc[] = [];
    let max = from;
    for (const [id, entry] of this.collection(kind)) {
      if (entry.stamp <= from) continue;
      docs.push({ id, data: structuredClone(entry.data) });
      max = Math.max(max, entry.stamp);
    }
    return { docs, cursor: docs.length ? { seconds: max, nanos: 0 } : cursor };
  }

  doc(kind: SyncedKind, id: string): Record<string, unknown> | undefined {
    return this.collection(kind).get(id)?.data;
  }

  /** Overwrite a cloud doc directly, as a racing device would. */
  forceWrite(kind: SyncedKind, id: string, data: Record<string, unknown>): void {
    this.collection(kind).set(id, { data, stamp: ++this.stamp });
  }
}

const devices: MandarinDB[] = [];
let n = 0;

async function device(): Promise<MandarinDB> {
  const database = new MandarinDB(`sync-device-${n++}`);
  devices.push(database);
  await database.open();
  return database;
}

afterEach(async () => {
  for (const d of devices.splice(0)) {
    d.close();
    await Dexie.delete(d.name);
  }
});

const deck = (id = 'd1'): Deck => ({ id, name: `Deck ${id}`, importedAt: 1, cardCount: 0, deleted: 0 });
const card = (id: string, deckId = 'd1'): Card => ({
  id,
  deckId,
  hanzi: `汉${id}`,
  pinyin: 'pin',
  spanish: `es ${id}`,
  kind: 'word',
  deleted: 0,
  suspended: 0,
  createdAt: 1,
  updatedAt: 1,
});
const review = (cardId: string, reps: number, stability: number): Review => ({
  cardId,
  mode: 'recognition',
  stability,
  difficulty: 5,
  due: 10_000,
  lastReview: 5_000,
  state: 'review',
  lapses: 0,
  reps,
  step: 0,
  leech: 0,
});
const log = (id: string, cardId: string): LogEntry => ({
  id,
  cardId,
  mode: 'recognition',
  grade: 3,
  reviewedAt: 5_000,
  elapsedMs: 3_000,
  prevState: 'review',
});

async function seed(database: MandarinDB): Promise<void> {
  // cardCount as the importer would write it (it is derived, and devices recount).
  await database.decks.put({ ...deck(), cardCount: 3 });
  await database.cards.bulkPut([card('a'), card('b'), card('c')]);
  await database.reviews.bulkPut([review('a', 3, 10), review('b', 3, 10)]);
  await database.reviewLogs.bulkPut([log('l1', 'a'), log('l2', 'b')]);
  await database.settings.put({ key: 'settings', value: { newPerDay: 15 } });
  await database.settings.put({ key: 'lastSession', value: { mode: 'dictation' } });
}

async function snapshot(database: MandarinDB) {
  const strip = <T extends { dirty?: unknown }>(rows: T[]) =>
    rows.map(({ dirty: _d, ...rest }) => rest).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  return {
    decks: strip(await database.decks.toArray()),
    cards: strip(await database.cards.toArray()),
    reviews: strip(await database.reviews.toArray()),
    logs: strip(await database.reviewLogs.toArray()),
    settings: strip((await database.settings.toArray()).filter((s) => s.key === 'settings')),
  };
}

describe('merge rules', () => {
  it('takes anything missing locally', () => {
    expect(incomingWins('cards', undefined, { updatedAt: 1 })).toBe(true);
  });

  it('last writer wins on updatedAt, both directions', () => {
    expect(incomingWins('cards', { updatedAt: 5 }, { updatedAt: 6 })).toBe(true);
    expect(incomingWins('cards', { updatedAt: 6 }, { updatedAt: 5 })).toBe(false);
  });

  it('breaks review ties by repetitions, other ties keep local', () => {
    expect(incomingWins('reviews', { updatedAt: 5, reps: 3 }, { updatedAt: 5, reps: 4 })).toBe(true);
    expect(incomingWins('reviews', { updatedAt: 5, reps: 4 }, { updatedAt: 5, reps: 3 })).toBe(false);
    expect(incomingWins('cards', { updatedAt: 5 }, { updatedAt: 5 })).toBe(false);
  });

  it('never replaces an existing log', () => {
    expect(incomingWins('logs', { updatedAt: 1 }, { updatedAt: 999 })).toBe(false);
  });
});

describe('SyncEngine', () => {
  it('uploads a full device and a fresh device downloads an identical copy', async () => {
    const remote = new MemoryRemote();
    const a = await device();
    const b = await device();
    await seed(a);

    const first = await new SyncEngine(remote, a, 'u1').sync();
    expect(first.pushed).toBe(1 + 3 + 2 + 2 + 1); // decks, cards, reviews, logs, settings
    expect(await new SyncEngine(remote, a, 'u1').pendingCount()).toBe(0);

    await new SyncEngine(remote, b, 'u1').sync();
    expect(await snapshot(b)).toEqual(await snapshot(a));
    // Downloaded rows are clean: nothing to push back.
    expect(await new SyncEngine(remote, b, 'u1').pendingCount()).toBe(0);
    // UI-only settings never leave the device.
    expect(remote.doc('settings', 'lastSession')).toBeUndefined();
    expect(await b.settings.get('lastSession')).toBeUndefined();
  });

  it('merges independent offline work from two devices, keeping all history', async () => {
    const remote = new MemoryRemote();
    const a = await device();
    const b = await device();
    await seed(a);
    const syncA = new SyncEngine(remote, a, 'u1');
    const syncB = new SyncEngine(remote, b, 'u1');
    await syncA.sync();
    await syncB.sync();

    // Offline: A studies card a, B studies card b.
    await a.reviews.put(review('a', 4, 20));
    await a.reviewLogs.put(log('la', 'a'));
    await b.reviews.put(review('b', 4, 25));
    await b.reviewLogs.put(log('lb', 'b'));

    await syncA.sync();
    await syncB.sync();
    await syncA.sync();

    expect(await snapshot(a)).toEqual(await snapshot(b));
    expect((await a.reviews.get(['a', 'recognition']))?.stability).toBe(20);
    expect((await a.reviews.get(['b', 'recognition']))?.stability).toBe(25);
    expect(await a.reviewLogs.count()).toBe(4);
  });

  it('resolves the same card studied on both devices to the later study, keeping both logs', async () => {
    const remote = new MemoryRemote();
    const a = await device();
    const b = await device();
    await seed(a);
    const syncA = new SyncEngine(remote, a, 'u1');
    const syncB = new SyncEngine(remote, b, 'u1');
    await syncA.sync();
    await syncB.sync();

    await a.reviews.put(review('a', 4, 30)); // earlier
    await a.reviewLogs.put(log('from-a', 'a'));
    await b.reviews.put(review('a', 4, 40)); // later stamp wins
    await b.reviewLogs.put(log('from-b', 'a'));

    await syncA.sync(); // A uploads first
    await syncB.sync(); // B's newer version wins and is uploaded
    await syncA.sync(); // A receives it

    expect((await a.reviews.get(['a', 'recognition']))?.stability).toBe(40);
    expect((await b.reviews.get(['a', 'recognition']))?.stability).toBe(40);
    const logIds = (await a.reviewLogs.toArray()).map((l) => l.id);
    expect(logIds).toEqual(expect.arrayContaining(['from-a', 'from-b']));
  });

  it('never rolls the cloud back with an older local copy', async () => {
    const remote = new MemoryRemote();
    const a = await device();
    const b = await device();
    await seed(a);
    const syncA = new SyncEngine(remote, a, 'u1');
    const syncB = new SyncEngine(remote, b, 'u1');
    await syncA.sync();
    await syncB.sync();

    await a.reviews.put(review('a', 4, 30)); // A edits first (older)…
    await b.reviews.put(review('a', 4, 40)); // …B edits later
    await syncB.sync(); // cloud has B's newer copy
    await syncA.sync(); // A must pull first and drop its older edit, not overwrite

    expect(remote.doc('reviews', 'a__recognition')?.stability).toBe(40);
    expect((await a.reviews.get(['a', 'recognition']))?.stability).toBe(40);
  });

  it('propagates a deleted deck instead of resurrecting it', async () => {
    const remote = new MemoryRemote();
    const a = await device();
    const b = await device();
    await seed(a);
    const syncA = new SyncEngine(remote, a, 'u1');
    const syncB = new SyncEngine(remote, b, 'u1');
    await syncA.sync();
    await syncB.sync();

    await a.transaction('rw', a.decks, a.cards, async () => {
      await a.cards.where('[deckId+deleted]').equals(['d1', 0]).modify({ deleted: 1 });
      await a.decks.update('d1', { deleted: 1 });
    });
    await syncA.sync();
    await syncB.sync();

    expect((await b.decks.get('d1'))?.deleted).toBe(1);
    expect(await b.cards.where('[deckId+deleted]').equals(['d1', 0]).count()).toBe(0);
    expect((await b.decks.get('d1'))?.cardCount).toBe(0);
  });

  it('keeps an edit made while its row was uploading queued for the next sync', async () => {
    const remote = new MemoryRemote();
    const a = await device();
    await seed(a);
    const syncA = new SyncEngine(remote, a, 'u1');

    remote.afterPush = async () => {
      await a.settings.put({ key: 'settings', value: { newPerDay: 99 } });
    };
    // The first push is decks; the settings edit lands mid-sync, before
    // settings are read for upload, so it goes out in this same sync.
    await syncA.sync();
    expect(remote.doc('settings', 'settings')?.value).toEqual({ newPerDay: 99 });

    // Now race an edit against the settings upload itself.
    await a.settings.put({ key: 'settings', value: { newPerDay: 1 } });
    remote.afterPush = async () => {
      await a.settings.put({ key: 'settings', value: { newPerDay: 2 } });
    };
    await syncA.sync();
    // The in-flight edit (2) must still be pending, not marked clean.
    expect((await a.settings.get('settings'))?.dirty).toBe(1);
    await syncA.sync();
    expect(remote.doc('settings', 'settings')?.value).toEqual({ newPerDay: 2 });
  });

  it('heals a cloud copy that fell behind this device', async () => {
    const remote = new MemoryRemote();
    const a = await device();
    await seed(a);
    const syncA = new SyncEngine(remote, a, 'u1');
    await syncA.sync();

    // A racing device overwrote the cloud with an older version of card a.
    const stale = { ...(remote.doc('cards', 'a') as Record<string, unknown>), spanish: 'viejo', updatedAt: 0 };
    remote.forceWrite('cards', 'a', stale);

    await syncA.sync(); // sees the older cloud copy, keeps local, re-queues it
    await syncA.sync(); // …and re-uploads
    expect(remote.doc('cards', 'a')?.spanish).toBe('es a');
    expect((await a.cards.get('a'))?.spanish).toBe('es a');
  });

  it('is idempotent: syncing again with no changes applies and pushes nothing', async () => {
    const remote = new MemoryRemote();
    const a = await device();
    await seed(a);
    const syncA = new SyncEngine(remote, a, 'u1');
    await syncA.sync();
    const before = await snapshot(a);

    const again = await syncA.sync();
    expect(again.pushed).toBe(0);
    expect(again.applied).toBe(0);
    expect(await snapshot(a)).toEqual(before);
  });

  it('shares one in-flight sync between concurrent callers', async () => {
    const remote = new MemoryRemote();
    const a = await device();
    await seed(a);
    const syncA = new SyncEngine(remote, a, 'u1');
    const [first, second] = await Promise.all([syncA.sync(), syncA.sync()]);
    expect(first).toBe(second);
    expect(remote.pushes).toBe(5); // one batch per kind, not two
  });

  it('does not re-download its own last batch on every sync (free-quota guard)', async () => {
    const remote = new MemoryRemote();
    const a = await device();
    await seed(a);
    const syncA = new SyncEngine(remote, a, 'u1');
    await syncA.sync(); // upload
    await syncA.sync(); // reads back its own upload once (newer than the cursor)
    const quiet = await syncA.sync();
    expect(quiet.pulled).toBe(0);
  });

  it('keeps cursors per account', async () => {
    const remote = new MemoryRemote();
    const a = await device();
    await seed(a);
    await new SyncEngine(remote, a, 'u1').sync();
    const keys = (await a.syncState.toArray()).map((r) => r.key);
    expect(keys.every((k) => k.startsWith('cursor:u1:'))).toBe(true);
  });
});
