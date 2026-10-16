import type { Table, Transaction } from 'dexie';

/**
 * Automatic change tracking for sync.
 *
 * Every write to a synced table goes through Dexie's CRUD hooks, which stamp
 * `updatedAt` and set `dirty = 1`. Doing this in hooks rather than at each call
 * site matters: application code often writes `{ ...prior, field }`, and if
 * `prior` came from the cloud it carries `dirty: 0` — a hand-maintained flag
 * would silently never upload that change.
 *
 * A transaction can opt out by declaring a mode:
 * - 'track'    (default) user action: dirty = 1, updatedAt = now.
 * - 'preserve' merging rows that bring their own timestamps (backup import):
 *              dirty = 1, but keep the row's updatedAt so an old backup
 *              doesn't masquerade as the newest change.
 * - 'raw'      hands off: applying cloud data or a schema upgrade, where the
 *              caller sets every field explicitly.
 */
export type WriteMode = 'track' | 'preserve' | 'raw';

const modes = new WeakMap<object, WriteMode>();

export function setWriteMode(tx: Transaction, mode: WriteMode): void {
  modes.set(tx, mode);
}

function modeOf(trans: Transaction | undefined): WriteMode {
  // Hooks may see a sub-transaction; walk up to the one the mode was set on.
  let current: (Transaction & { parent?: Transaction }) | undefined = trans;
  while (current) {
    const mode = modes.get(current);
    if (mode) return mode;
    current = current.parent;
  }
  return 'track';
}

let lastStamp = 0;

/**
 * Strictly increasing timestamp. Two edits in the same millisecond must still
 * be ordered, otherwise "clear dirty if updatedAt is unchanged" after an upload
 * could swallow the second edit.
 */
export function nextStamp(): number {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

export function newId(): string {
  return crypto.randomUUID();
}

type Tracked = { updatedAt?: number; dirty?: 0 | 1 };

/**
 * Install the tracking hooks on a table. `include` restricts tracking to some
 * rows (settings: only the synced keys, never UI state like the last session).
 */
export function installTracking<T extends Tracked, K>(
  table: Table<T, K>,
  include?: (row: T) => boolean,
): void {
  table.hook('creating', (_key, obj, trans) => {
    const mode = modeOf(trans);
    if (mode === 'raw') return;
    if (include && !include(obj)) return;
    obj.dirty = 1;
    if (mode === 'track' || obj.updatedAt === undefined) obj.updatedAt = nextStamp();
  });

  table.hook('updating', (_mods, _key, obj, trans) => {
    const mode = modeOf(trans);
    if (mode === 'raw') return undefined;
    if (include && !include(obj)) return undefined;
    if (mode === 'preserve') return { dirty: 1 };
    return { dirty: 1, updatedAt: nextStamp() };
  });
}
