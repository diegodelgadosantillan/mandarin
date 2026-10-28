import type { FirebaseOptions } from 'firebase/app';

/**
 * Firebase web app configuration, copied from the Firebase console
 * (Project settings → Your apps → Web app → SDK setup and configuration).
 *
 * This is public by design: it only identifies the project. Access is
 * controlled by Firestore security rules (each user can read and write only
 * users/{their uid}/…) and by the Authorized domains list in Authentication.
 *
 * Set to null to build a fully local app with sync hidden.
 */
export const firebaseConfig: FirebaseOptions | null = {
  apiKey: 'AIzaSyD0nTMN-SijwAtApZbp3ll1aTzaucs7rxw',
  authDomain: 'mandarin-8c4cc.firebaseapp.com',
  projectId: 'mandarin-8c4cc',
  storageBucket: 'mandarin-8c4cc.firebasestorage.app',
  messagingSenderId: '620772003636',
  appId: '1:620772003636:web:d222fd039295a607e6df61',
};
