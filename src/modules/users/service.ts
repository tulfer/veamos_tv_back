import { UserProfile, FavoriteItem, ContinueWatchingItem, HistoryItem, MediaItem } from '../../types';
import { storeKeys, getRow, setRow } from '../../services/store';

interface UserRow {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  createdAt: number;
  profiles: UserProfile[];
}

interface ItemsRow<T> {
  items: T[];
}

async function getUserRow(uid: string): Promise<UserRow | null> {
  return getRow<UserRow>(storeKeys.user(uid));
}

export async function getOrCreateUser(uid: string, email: string, displayName?: string) {
  const existing = await getUserRow(uid);
  if (existing) return existing;

  const user: UserRow = {
    uid,
    email,
    displayName: displayName || email.split('@')[0],
    createdAt: Date.now(),
    profiles: [
      { id: 'default', name: 'Default', avatar: '', isChild: false, pin: '' },
    ],
  };

  await setRow(storeKeys.user(uid), user);
  return user;
}

export async function getProfiles(uid: string): Promise<UserProfile[]> {
  const user = await getUserRow(uid);
  return user?.profiles || [];
}

export async function updateProfiles(uid: string, profiles: UserProfile[]) {
  const user = await getUserRow(uid);
  if (!user) return;
  await setRow(storeKeys.user(uid), { ...user, profiles });
}

export async function addProfile(uid: string, profile: UserProfile) {
  const user = await getUserRow(uid);
  if (!user) return;
  const profiles = user.profiles || [];
  profiles.push(profile);
  await setRow(storeKeys.user(uid), { ...user, profiles });
}

async function getProfileItems<T>(key: string): Promise<T[]> {
  const row = await getRow<ItemsRow<T>>(key);
  return row?.items || [];
}

async function setProfileItems<T>(key: string, items: T[]): Promise<void> {
  await setRow<ItemsRow<T>>(key, { items });
}

export async function getFavorites(uid: string, profileId: string): Promise<FavoriteItem[]> {
  return getProfileItems<FavoriteItem>(storeKeys.favorites(uid, profileId));
}

export async function addFavorite(uid: string, profileId: string, item: FavoriteItem) {
  const key = storeKeys.favorites(uid, profileId);
  const items = await getProfileItems<FavoriteItem>(key);
  const exists = items.some((i) => i.id === item.id);
  if (!exists) {
    items.push({ ...item, addedAt: Date.now() });
    await setProfileItems(key, items);
  }
}

export async function removeFavorite(uid: string, profileId: string, itemId: string) {
  const key = storeKeys.favorites(uid, profileId);
  const items = (await getProfileItems<FavoriteItem>(key)).filter((i) => i.id !== itemId);
  await setProfileItems(key, items);
}

export async function getContinueWatching(uid: string, profileId: string): Promise<ContinueWatchingItem[]> {
  return getProfileItems<ContinueWatchingItem>(storeKeys.continueWatching(uid, profileId));
}

export async function upsertContinueWatching(uid: string, profileId: string, item: ContinueWatchingItem) {
  const key = storeKeys.continueWatching(uid, profileId);
  const items = await getProfileItems<ContinueWatchingItem>(key);
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    items[idx] = { ...item, updatedAt: Date.now() };
  } else {
    items.push({ ...item, updatedAt: Date.now() });
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  await setProfileItems(key, items);
}

export async function getHistory(uid: string, profileId: string): Promise<HistoryItem[]> {
  return getProfileItems<HistoryItem>(storeKeys.history(uid, profileId));
}

export async function getRecommendations(uid: string, profileId: string): Promise<MediaItem[]> {
  return getProfileItems<MediaItem>(storeKeys.recommendations(profileId));
}