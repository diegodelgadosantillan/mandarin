/**
 * Conflict rules for combining two copies of the same row — one already on
 * this device, one arriving from the cloud or from a backup file. Pure, so
 * both paths resolve conflicts identically and the rules are unit-testable.
 */

export type SyncedKind = 'decks' | 'cards' | 'reviews' | 'logs' | 'settings';

interface Comparable {
  updatedAt?: number;
  reps?: number;
}

/**
 * Should `incoming` replace `local`?
 *
 * - Missing locally → always take it.
 * - Logs are immutable facts ("this answer happened"): a log that exists on
 *   both sides is the same log, so the local copy is kept. Logs from both
 *   devices are unioned — history is never lost.
 * - Everything else is last-writer-wins on `updatedAt`. For reviews this is
 *   deliberately updatedAt rather than lastReview: resetting a leech's lapse
 *   counter changes the row without a new review, and must still propagate.
 * - Ties (same stamp): a review with more repetitions has seen more history;
 *   otherwise keep what is here, so syncing twice is a no-op.
 */
export function incomingWins(kind: SyncedKind, local: Comparable | undefined, incoming: Comparable): boolean {
  if (!local) return true;
  if (kind === 'logs') return false;
  const localStamp = local.updatedAt ?? 0;
  const incomingStamp = incoming.updatedAt ?? 0;
  if (incomingStamp !== localStamp) return incomingStamp > localStamp;
  if (kind === 'reviews') return (incoming.reps ?? 0) > (local.reps ?? 0);
  return false;
}

/** Strip device-local bookkeeping before a row leaves the device. */
export function forExport<T extends { dirty?: 0 | 1 }>(row: T): Omit<T, 'dirty'> {
  const { dirty: _dirty, ...rest } = row;
  return rest;
}
