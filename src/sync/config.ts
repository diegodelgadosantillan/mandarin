import type { FirebaseOptions } from 'firebase/app';

/**
 * Firebase web app configuration, copied from the Firebase console
 * (Project settings → Your apps → Web app → SDK setup and configuration).
 *
 * This is public by design: it only identifies the project. Access is
 * controlled by Firestore security rules (each user can read and write only
 * users/{their uid}/…) and by the Authorized domains list in Authentication.
 *
 * While this is null the app works exactly as before, fully local, and the
 * sync section in Ajustes explains that sync isn't configured.
 */
export const firebaseConfig: FirebaseOptions | null = null;
