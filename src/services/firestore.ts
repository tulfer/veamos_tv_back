import { getFirestore } from '../config/firebase';

let db: ReturnType<typeof getFirestore> | null = null;

function getDb() {
  if (!db) {
    db = getFirestore();
  }
  return db;
}

export const collections = {
  users: () => getDb().collection('users'),
  cache: () => getDb().collection('cache'),
  recommendations: () => getDb().collection('recommendations'),
};

export async function getUserDoc(uid: string) {
  const doc = await collections.users().doc(uid).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

export async function getUserProfiles(uid: string) {
  const doc = await collections.users().doc(uid).get();
  if (!doc.exists) return [];
  return doc.data()?.profiles || [];
}

export async function getFavorites(uid: string, profileId: string) {
  const doc = await collections.users().doc(uid).collection('favorites').doc(profileId).get();
  return doc.exists ? (doc.data()?.items || []) : [];
}

export async function addFavorite(uid: string, profileId: string, item: any) {
  await collections.users().doc(uid).collection('favorites').doc(profileId).set(
    { items: item },
    { merge: true },
  );
}

export async function removeFavorite(uid: string, profileId: string, itemId: string) {
  const doc = await collections.users().doc(uid).collection('favorites').doc(profileId).get();
  if (!doc.exists) return;
  const items = doc.data()?.items || [];
  const filtered = items.filter((i: any) => i.id !== itemId);
  await doc.ref.update({ items: filtered });
}

export async function getContinueWatching(uid: string, profileId: string) {
  const snapshot = await collections.users()
    .doc(uid)
    .collection('continue-watching')
    .doc(profileId)
    .get();
  return snapshot.exists ? (snapshot.data()?.items || []) : [];
}

export async function upsertContinueWatching(uid: string, profileId: string, item: any) {
  await collections.users().doc(uid).collection('continue-watching').doc(profileId).set(
    { items: item },
    { merge: true },
  );
}

export async function getHistory(uid: string, profileId: string, limit = 20) {
  const snapshot = await collections.users()
    .doc(uid)
    .collection('history')
    .doc(profileId)
    .get();
  return snapshot.exists ? (snapshot.data()?.items || []) : [];
}
