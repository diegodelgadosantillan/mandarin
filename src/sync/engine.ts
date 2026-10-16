import type { Table } from 'dexie';
import { SYNCED_SETTING_KEYS, type MandarinDB } from '../db/db.ts';
import { setWriteMode } from '../db/tracking.ts';
import { recountDecks } from './apply.ts';
import { forExport, incomingWins, type SyncedKind } from './merge.ts';
import { SYNCED_KINDS, type Cursor, type RemoteDoc, type RemoteStore } from './remote.ts';

/** Firestore allows 500 writes per batch; stay clear of the limit. */
const BATCH_SIZE = 450;

type Row = Record<string, unknown> & { updatedAt?: number; dirty?: 0 | 1; reps?: number };

interface KindSpec {
  table(database: MandarinDB): Table<Row, unknown>;
  /** Document id in the cloud. */
  remoteId(row: Row): string;
  /** Primary key in IndexedDB. */
  localKey(row: Row): unknown;
  /** Rows of this table that sync at all. */
  include?(row: Row): boolean;
}

const asTable = <T, K>(table: Table<T, K>): Table<Row, unknown> => table as unknown as Table<Row, unknown>;

const SPECS: Record<SyncedKind, KindSpec> = {
  decks: { table: (d) => asTable(d.decks), remoteId: (r) => String(r.id), localKey: (r) => r.id },
  cards: { table: (d) => asTable(d.cards), remoteId: (r) => String(r.id), localKey: (r) => r.id },
  reviews: {
    table: (d) => asTable(d.reviews),
    remoteId: (r) => `${String(r.cardId)}__${String(r.mode)}`,
    localKey: (r) => [r.cardId, r.mode],
  },
  logs: { table: (d) => asTable(d.reviewLogs), remoteId: (r) => String(r.id), localKey: (r) => r.id },
  settings: {
    table: (d) => asTable(d.settings),
    remoteId: (r) => String(r.key),
    localKey: (r) => r.key,
    include: (r) => SYNCED_SETTING_KEYS.includes(String(r.key)),
  },
};

/** Drop server-side bookkeeping fields (prefixed `_`, e.g. `_syncedAt`). */
function fromRemote(doc: RemoteDoc): Row {
  const row: Row = {};
  for (const [key, value] of Object.entries(doc.data)) if (!key.startsWith('_')) row[key] = value;
  return row;
}

export interface SyncReport {
  /** Rows uploaded. */
  pushed: number;
  /** Documents downloaded. */
  pulled: number;
  /** Downloaded documents that actually changed something here. */
  applied: number;
}

/**
 * Two-way sync between this device's IndexedDB and a RemoteStore.
 *
 * Offline-first: IndexedDB stays the source of truth and the app never waits
 * on the network; a failed sync leaves everything queued for the next one.
 */
export class SyncEngine {
  private running: Promise<SyncReport> | null = null;

  constructor(
    private readonly remote: RemoteStore,
    private readonly database: MandarinDB,
    /** Account id, so cursors don't leak between accounts on one device. */
    private readonly scope: string,
  ) {}

  /** Run a sync; concurrent callers share the one already in flight. */
  sync(): Promise<SyncReport> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /** Local changes not yet uploaded. */
  async pendingCount(): Promise<number> {
    let total = 0;
    for (const kind of SYNCED_KINDS) {
      const spec = SPECS[kind];
      const dirty = spec.table(this.database).where('dirty').equals(1);
      total += spec.include ? (await dirty.toArray()).filter(spec.include).length : await dirty.count();
    }
    return total;
  }

  private async run(): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, pulled: 0, applied: 0 };
    // Pull before push. Pushing overwrites the cloud copy unconditionally, so a
    // row must first be checked against the cloud: if the cloud's is newer, the
    // pull replaces the local row (clearing its dirty flag) and it isn't pushed.
    for (const kind of SYNCED_KINDS) {
      const { pulled, applied } = await this.pull(kind);
      report.pulled += pulled;
      report.applied += applied;
    }
    for (const kind of SYNCED_KINDS) report.pushed += await this.push(kind);
    return report;
  }

  private cursorKey(kind: SyncedKind): string {
    return `cursor:${this.scope}:${kind}`;
  }

  private async pull(kind: SyncedKind): Promise<{ pulled: number; applied: number }> {
    const spec = SPECS[kind];
    const table = spec.table(this.database);
    const cursor = ((await this.database.syncState.get(this.cursorKey(kind)))?.value ?? null) as Cursor;

    const { docs, cursor: next } = await this.remote.pullSince(kind, cursor);
    if (docs.length === 0) return { pulled: 0, applied: 0 };

    let rows = docs.map(fromRemote);
    if (spec.include) rows = rows.filter(spec.include);

    const tables = [...new Set([table, this.database.decks, this.database.cards, this.database.syncState])];
    let applied = 0;
    await this.database.transaction('rw', tables, async (tx) => {
      setWriteMode(tx, 'raw');
      const locals = await table.bulkGet(rows.map(spec.localKey));
      const writes: Row[] = [];
      const reassert: unknown[] = [];

      rows.forEach((row, index) => {
        const local = locals[index];
        if (incomingWins(kind, local, row)) {
          writes.push({ ...row, dirty: 0 });
        } else if (local && local.dirty !== 1 && (local.updatedAt ?? 0) > (row.updatedAt ?? 0)) {
          // The cloud holds an older copy than this device already uploaded
          // (another device pushed in between). Queue ours again so the cloud
          // converges instead of staying behind forever.
          reassert.push(spec.localKey(local));
        }
      });

      if (writes.length > 0) await table.bulkPut(writes);
      for (const key of reassert) await table.update(key, { dirty: 1 });
      if (writes.length > 0 && (kind === 'cards' || kind === 'decks')) await recountDecks(this.database);
      await this.database.syncState.put({ key: this.cursorKey(kind), value: next });
      applied = writes.length;
    });

    return { pulled: docs.length, applied };
  }

  private async push(kind: SyncedKind): Promise<number> {
    const spec = SPECS[kind];
    const table = spec.table(this.database);
    let rows = await table.where('dirty').equals(1).toArray();
    if (spec.include) rows = rows.filter(spec.include);

    let pushed = 0;
    for (let start = 0; start < rows.length; start += BATCH_SIZE) {
      const chunk = rows.slice(start, start + BATCH_SIZE);
      await this.remote.push(
        kind,
        chunk.map((row) => ({ id: spec.remoteId(row), data: forExport(row) as Record<string, unknown> })),
      );

      // Clear dirty only where the row is unchanged since it was read: an edit
      // made while the upload was in flight has a newer stamp and stays queued.
      await this.database.transaction('rw', table, async (tx) => {
        setWriteMode(tx, 'raw');
        const current = await table.bulkGet(chunk.map(spec.localKey));
        for (let i = 0; i < chunk.length; i++) {
          const sent = chunk[i] as Row;
          if (current[i] && current[i]?.updatedAt === sent.updatedAt) {
            await table.update(spec.localKey(sent), { dirty: 0 });
          }
        }
      });
      pushed += chunk.length;
    }
    return pushed;
  }
}
