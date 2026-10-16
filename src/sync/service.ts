import { db } from '../db/db.ts';
import { onLocalChange } from '../db/tracking.ts';
import { firebaseConfig } from './config.ts';
import { SyncEngine } from './engine.ts';
import type { FirebaseBackend, SyncUser } from './firebase-remote.ts';

/**
 * App-facing sync controller: account state, when to sync, and a status the
 * UI can subscribe to. Firebase is loaded lazily on first use; nothing here
 * ever blocks studying.
 */

export type SyncState = 'unconfigured' | 'loading' | 'signed-out' | 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  email: string | null;
  lastSyncAt: number | null;
  pending: number;
  error: string | null;
}

const INTERVAL_MS = 5 * 60_000;
/** Local edits wait this long so a run of grades becomes one upload, not twenty. */
const DEBOUNCE_MS = 8_000;
const LAST_SYNC_KEY = 'lastSyncAt';

let status: SyncStatus = {
  state: firebaseConfig ? 'loading' : 'unconfigured',
  email: null,
  lastSyncAt: null,
  pending: 0,
  error: null,
};
const listeners = new Set<(s: SyncStatus) => void>();

let backendPromise: Promise<FirebaseBackend> | null = null;
let engine: SyncEngine | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const listener of listeners) listener(status);
}

export function getSyncStatus(): SyncStatus {
  return status;
}

/** Subscribe to status changes; called immediately with the current status. */
export function onSyncStatus(listener: (s: SyncStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

function backend(): Promise<FirebaseBackend> {
  if (!firebaseConfig) return Promise.reject(new Error('Sync no configurado'));
  if (!backendPromise) {
    const config = firebaseConfig;
    backendPromise = import('./firebase-remote.ts').then((m) => m.createBackend(config));
  }
  return backendPromise;
}

async function refreshPending(): Promise<void> {
  if (engine) setStatus({ pending: await engine.pendingCount() });
}

async function runSync(): Promise<void> {
  if (!engine) return;
  if (!navigator.onLine) {
    await refreshPending();
    setStatus({ state: 'offline' });
    return;
  }
  setStatus({ state: 'syncing', error: null });
  try {
    await engine.sync();
    const now = Date.now();
    await db.syncState.put({ key: LAST_SYNC_KEY, value: now });
    setStatus({ state: 'idle', lastSyncAt: now });
  } catch (error) {
    // Nothing is lost on failure: unsent rows stay dirty for the next attempt.
    console.warn('Sync failed:', error);
    setStatus({ state: navigator.onLine ? 'error' : 'offline', error: describeError(error) });
  }
  await refreshPending();
}

/**
 * Ask for a sync soon. Bursts of calls (several grades, an import) coalesce
 * into one. Safe to call when signed out or unconfigured: it does nothing.
 */
export function requestSync(immediate = false): void {
  if (!engine) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  if (immediate) {
    debounceTimer = null;
    void runSync();
  } else {
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runSync();
    }, DEBOUNCE_MS);
  }
}

async function onUser(user: SyncUser | null): Promise<void> {
  if (!user) {
    engine = null;
    setStatus({ state: 'signed-out', email: null, pending: 0, error: null });
    return;
  }
  const remote = (await backend()).remote(user.uid);
  engine = new SyncEngine(remote, db, user.uid);
  const last = (await db.syncState.get(LAST_SYNC_KEY))?.value;
  setStatus({ state: 'idle', email: user.email, lastSyncAt: typeof last === 'number' ? last : null });
  requestSync(true);
}

/**
 * Start sync at app boot. Deferred so it never competes with first paint, and
 * a no-op when Firebase isn't configured.
 */
export function startSync(): void {
  if (started || !firebaseConfig) return;
  started = true;

  // Every tracked local write (grade, import, suspend, settings…) schedules an
  // upload — no screen has to remember to ask.
  onLocalChange(() => requestSync());

  const boot = (): void => {
    backend()
      .then((b) => b.onUser((user) => void onUser(user)))
      .catch((error) => {
        // Usually: first launch while offline, so the SDK chunk isn't cached yet.
        console.warn('Sync unavailable:', error);
        setStatus({ state: navigator.onLine ? 'error' : 'offline', error: describeError(error) });
        backendPromise = null;
        started = false;
      });
  };
  setTimeout(boot, 300);

  window.addEventListener('online', () => {
    if (!started) startSync();
    requestSync(true);
  });
  window.addEventListener('offline', () => {
    if (engine) setStatus({ state: 'offline' });
  });
  // Coming back to the app: catch up. Leaving it (iOS gives no later chance):
  // push what's pending right away.
  document.addEventListener('visibilitychange', () => requestSync(true));
  setInterval(() => requestSync(true), INTERVAL_MS);
}

export async function signIn(email: string, password: string): Promise<void> {
  await (await backend()).signIn(email.trim(), password);
}

export async function signUp(email: string, password: string): Promise<void> {
  await (await backend()).signUp(email.trim(), password);
}

export async function resetPassword(email: string): Promise<void> {
  await (await backend()).resetPassword(email.trim());
}

/** Sign out. Local data stays on the device; it simply stops syncing. */
export async function signOutSync(): Promise<void> {
  await (await backend()).signOut();
}

/** Firebase error codes → something a person can act on, in Spanish. */
export function describeError(error: unknown): string {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Correo o contraseña incorrectos.';
    case 'auth/email-already-in-use':
      return 'Ya existe una cuenta con ese correo. Usa «Entrar».';
    case 'auth/invalid-email':
      return 'Ese correo no es válido.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'La contraseña debe tener al menos 6 caracteres.';
    case 'auth/missing-password':
      return 'Escribe la contraseña.';
    case 'auth/too-many-requests':
      return 'Demasiados intentos. Espera unos minutos.';
    case 'auth/network-request-failed':
    case 'unavailable':
      return 'Sin conexión con el servidor. Se reintentará automáticamente.';
    case 'permission-denied':
      return 'El servidor rechazó el acceso. Revisa las reglas de Firestore.';
    case 'resource-exhausted':
      return 'Se alcanzó el límite gratuito diario de Firebase. La sincronización se reanuda mañana; nada se pierde.';
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
