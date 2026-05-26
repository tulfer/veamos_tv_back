import { collections } from '../../services/firestore';
import { UserProfile, FavoriteItem, ContinueWatchingItem, HistoryItem, MediaItem } from '../../types';

export async function getOrCreateUser(uid: string, email: string, displayName?: string) {
  const doc = await collections.users().doc(uid).get();
  if (doc.exists) return { id: doc.id, ...doc.data() } as any;

  const user = {
    uid,
    email,
    displayName: displayName || email.split('@')[0],
    createdAt: Date.now(),
    profiles: [
      { id: 'default', name: 'Default', avatar: '', isChild: false, pin: '' },
    ],
  };

  await collections.users().doc(uid).set(user);
  return user;
}

export async function getProfiles(uid: string): Promise<UserProfile[]> {
  const doc = await collections.users().doc(uid).get();
  return doc.data()?.profiles || [];
}

export async function updateProfiles(uid: string, profiles: UserProfile[]) {
  await collections.users().doc(uid).update({ profiles });
}

export async function addProfile(uid: string, profile: UserProfile) {
  const doc = await collections.users().doc(uid).get();
  const profiles = doc.data()?.profiles || [];
  profiles.push(profile);
  await doc.ref?.update({ profiles }) || await collections.users().doc(uid).update({ profiles });
}

export async function getFavorites(uid: string, profileId: string): Promise<FavoriteItem[]> {
  const doc = await collections.users().doc(uid).collection('favorites').doc(profileId).get();
  return doc.data()?.items || [];
}

export async function addFavorite(uid: string, profileId: string, item: FavoriteItem) {
  const ref = collections.users().doc(uid).collection('favorites').doc(profileId);
  const doc = await ref.get();
  const items = doc.data()?.items || [];
  const exists = items.some((i: any) => i.id === item.id);
  if (!exists) {
    items.push({ ...item, addedAt: Date.now() });
    await ref.set({ items }, { merge: true });
  }
}

export async function removeFavorite(uid: string, profileId: string, itemId: string) {
  const ref = collections.users().doc(uid).collection('favorites').doc(profileId);
  const doc = await ref.get();
  const items = (doc.data()?.items || []).filter((i: any) => i.id !== itemId);
  await ref.set({ items }, { merge: true });
}

export async function getContinueWatching(uid: string, profileId: string): Promise<ContinueWatchingItem[]> {
  const doc = await collections.users().doc(uid).collection('continue-watching').doc(profileId).get();
  return doc.data()?.items || [];
}

export async function upsertContinueWatching(uid: string, profileId: string, item: ContinueWatchingItem) {
  const ref = collections.users().doc(uid).collection('continue-watching').doc(profileId);
  const doc = await ref.get();
  let items = doc.data()?.items || [];
  const idx = items.findIndex((i: any) => i.id === item.id);
  if (idx >= 0) {
    items[idx] = { ...item, updatedAt: Date.now() };
  } else {
    items.push({ ...item, updatedAt: Date.now() });
  }
  items.sort((a: any, b: any) => b.updatedAt - a.updatedAt);
  await ref.set({ items }, { merge: true });
}

export async function getHistory(uid: string, profileId: string): Promise<HistoryItem[]> {
  const doc = await collections.users().doc(uid).collection('history').doc(profileId).get();
  return doc.data()?.items || [];
}

export async function getRecommendations(uid: string, profileId: string): Promise<MediaItem[]> {
  const doc = await collections.recommendations().doc(profileId).get();
  return doc.data()?.items || [];
}
