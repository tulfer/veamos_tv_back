import admin from 'firebase-admin';
import { getFirestore } from '../config/firebase';
import { collections } from './firestore';
import { logger } from '../utils/logger';
import { SyncData, SyncMovie, SyncSeries, LiveChannel, MediaItem } from '../types';

function getDb() {
  return getFirestore();
}

async function getCollectionAsArray<T>(colRef: admin.firestore.CollectionReference): Promise<T[]> {
  const snapshot = await colRef.get();
  if (snapshot.empty) return [];
  return snapshot.docs.map(doc => {
    const data = doc.data() as Record<string, unknown>;
    return { id: doc.id, ...data } as unknown as T;
  });
}

async function replaceCollection<T extends { id: string }>(
  colRef: admin.firestore.CollectionReference,
  items: T[],
): Promise<void> {
  const existing = await colRef.get();
  const batch = getDb().batch();
  for (const doc of existing.docs) {
    batch.delete(doc.ref);
  }
  for (const item of items) {
    const { id, ...data } = item;
    batch.set(colRef.doc(id), data);
  }
  await batch.commit();
}

export async function loadSyncData(): Promise<SyncData | null> {
  try {
    const [movies, series, channels, popularMovies, popularSeries, estrenoMovies, estrenoSeries, metaSnap] =
      await Promise.all([
        getCollectionAsArray<SyncMovie>(collections.movies()),
        getCollectionAsArray<SyncSeries>(collections.series()),
        getCollectionAsArray<LiveChannel>(collections.channels()),
        getCollectionAsArray<MediaItem>(collections.popularMovies()),
        getCollectionAsArray<MediaItem>(collections.popularSeries()),
        getCollectionAsArray<SyncMovie>(collections.estrenoMovies()),
        getCollectionAsArray<SyncSeries>(collections.estrenoSeries()),
        collections.syncMeta().doc('data').get(),
      ]);

    const meta = metaSnap.exists ? (metaSnap.data() as { updatedAt?: number }) : null;

    return {
      movies,
      series,
      channels,
      popularMovies,
      popularSeries,
      estrenoMovies,
      estrenoSeries,
      updatedAt: meta?.updatedAt ?? Date.now(),
    };
  } catch (error) {
    logger.error({ error }, 'Failed to load sync data from Firestore');
    return null;
  }
}

export async function saveSyncData(data: SyncData): Promise<void> {
  try {
    await Promise.all([
      replaceCollection(collections.movies(), data.movies),
      replaceCollection(collections.series(), data.series),
      replaceCollection(collections.channels(), data.channels),
      replaceCollection(collections.popularMovies(), data.popularMovies),
      replaceCollection(collections.popularSeries(), data.popularSeries),
      replaceCollection(collections.estrenoMovies(), data.estrenoMovies),
      replaceCollection(collections.estrenoSeries(), data.estrenoSeries),
      collections.syncMeta().doc('data').set({ updatedAt: data.updatedAt }, { merge: true }),
    ]);
    logger.info(
      { movies: data.movies.length, series: data.series.length, channels: data.channels.length },
      'Sync data saved to Firestore',
    );
  } catch (error) {
    logger.error({ error }, 'Failed to save sync data to Firestore');
  }
}

export async function getSyncStats(): Promise<{
  movies: number;
  series: number;
  channels: number;
  updatedAt: number | null;
} | null> {
  try {
    const [moviesSnap, seriesSnap, channelsSnap, metaSnap] = await Promise.all([
      collections.movies().listDocuments(),
      collections.series().listDocuments(),
      collections.channels().listDocuments(),
      collections.syncMeta().doc('data').get(),
    ]);
    return {
      movies: moviesSnap.length,
      series: seriesSnap.length,
      channels: channelsSnap.length,
      updatedAt: metaSnap.exists ? ((metaSnap.data() as { updatedAt?: number })?.updatedAt ?? null) : null,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get sync stats');
    return null;
  }
}

export async function loadHomeData<T = unknown>(): Promise<T | null> {
  try {
    const doc = await collections.homeData().doc('cineby').get();
    if (!doc.exists) return null;
    return doc.data() as T;
  } catch (error) {
    logger.error({ error }, 'Failed to load home data from Firestore');
    return null;
  }
}

export async function saveHomeData(data: Record<string, unknown>): Promise<void> {
  try {
    await collections.homeData().doc('cineby').set({
      ...data,
      updatedAt: Date.now(),
    });
    logger.info('Home data saved to Firestore');
  } catch (error) {
    logger.error({ error }, 'Failed to save home data to Firestore');
  }
}
