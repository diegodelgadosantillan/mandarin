/**
 * Everything that touches Firebase lives in this module, and it is only ever
 * loaded with a dynamic import — the core app (and offline startup) never
 * waits on the Firebase SDK.
 */
import { initializeApp, type FirebaseOptions } from 'firebase/app';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDocs,
  initializeFirestore,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  Timestamp,
  where,
  writeBatch,
  type Firestore,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore/lite';
import type { SyncedKind } from './merge.ts';
import type { Cursor, PullResult, RemoteDoc, RemoteStore } from './remote.ts';

const PAGE_SIZE = 500;

export interface SyncUser {
  uid: string;
  email: string | null;
}

export interface FirebaseBackend {
  onUser(listener: (user: SyncUser | null) => void): void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  resetPassword(email: string): Promise<void>;
  signOut(): Promise<void>;
  remote(uid: string): RemoteStore;
}

/**
 * Cloud layout: users/{uid}/{decks|cards|reviews|logs|settings}/{id}.
 * Security rules restrict every path under users/{uid} to that signed-in user.
 */
class FirestoreRemote implements RemoteStore {
  constructor(
    private readonly firestore: Firestore,
    private readonly uid: string,
  ) {}

  private collectionFor(kind: SyncedKind) {
    return collection(this.firestore, 'users', this.uid, kind);
  }

  async push(kind: SyncedKind, docs: RemoteDoc[]): Promise<void> {
    const batch = writeBatch(this.firestore);
    for (const item of docs) {
      batch.set(doc(this.collectionFor(kind), item.id), { ...item.data, _syncedAt: serverTimestamp() });
    }
    await batch.commit();
  }

  async pullSince(kind: SyncedKind, cursor: Cursor): Promise<PullResult> {
    const docs: RemoteDoc[] = [];
    let next = cursor;
    let last: QueryDocumentSnapshot | undefined;

    const after: QueryConstraint[] = cursor
      ? [where('_syncedAt', '>', new Timestamp(cursor.seconds, cursor.nanos))]
      : [];

    for (;;) {
      const page = await getDocs(
        query(
          this.collectionFor(kind),
          ...after,
          orderBy('_syncedAt'),
          ...(last ? [startAfter(last)] : []),
          limit(PAGE_SIZE),
        ),
      );

      for (const snapshot of page.docs) {
        const data = snapshot.data() as Record<string, unknown>;
        docs.push({ id: snapshot.id, data });
        const stamp = data._syncedAt;
        if (stamp instanceof Timestamp) {
          const newer =
            !next ||
            stamp.seconds > next.seconds ||
            (stamp.seconds === next.seconds && stamp.nanoseconds > next.nanos);
          if (newer) next = { seconds: stamp.seconds, nanos: stamp.nanoseconds };
        }
      }

      if (page.docs.length < PAGE_SIZE) break;
      last = page.docs[page.docs.length - 1];
    }

    return { docs, cursor: next };
  }
}

export function createBackend(config: FirebaseOptions): FirebaseBackend {
  const app = initializeApp(config);

  // initializeAuth without a popup/redirect resolver: email + password needs
  // neither, which keeps the auth iframe out of the bundle and avoids the
  // redirect flow that breaks inside iOS home-screen apps. IndexedDB
  // persistence keeps the session across launches, offline included.
  const auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  });

  // Rows may carry optional fields set to undefined; Firestore rejects those
  // unless told to skip them.
  const firestore = initializeFirestore(app, { ignoreUndefinedProperties: true });

  return {
    onUser(listener) {
      onAuthStateChanged(auth, (user) => listener(user ? { uid: user.uid, email: user.email } : null));
    },
    async signIn(email, password) {
      await signInWithEmailAndPassword(auth, email, password);
    },
    async signUp(email, password) {
      await createUserWithEmailAndPassword(auth, email, password);
    },
    async resetPassword(email) {
      await sendPasswordResetEmail(auth, email);
    },
    async signOut() {
      await signOut(auth);
    },
    remote(uid) {
      return new FirestoreRemote(firestore, uid);
    },
  };
}
