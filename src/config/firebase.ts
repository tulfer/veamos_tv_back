import admin from 'firebase-admin';
import { env } from './env';

let firebaseApp: admin.app.App | null = null;

export function getFirebaseApp(): admin.app.App {
  if (firebaseApp) return firebaseApp;

  const hasCreds = env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY;

  if (hasCreds) {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
      }),
      databaseURL: env.FIREBASE_DATABASE_URL,
    });
  } else {
    firebaseApp = admin.initializeApp({
      projectId: env.FIREBASE_PROJECT_ID || 'veamos-tv',
    });
  }

  return firebaseApp;
}

export function getFirestore(): admin.firestore.Firestore {
  return getFirebaseApp().firestore();
}

export function getFirebaseAuth(): admin.auth.Auth {
  return getFirebaseApp().auth();
}
