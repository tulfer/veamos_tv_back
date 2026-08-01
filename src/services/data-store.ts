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

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined).map((item) => stripUndefined(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        clean[key] = stripUndefined(v);
      }
    }
    return clean as unknown as T;
  }
  return value;
}

async function replaceCollection<T extends { id: string }>(
  colRef: admin.firestore.CollectionReference,
  items: T[],
): Promise<void> {
  const existing = await colRef.get();
  const db = getDb();

  const ops: Array<{ ref: admin.firestore.DocumentReference; type: 'delete' | 'set'; data?: unknown }> = [
    ...existing.docs.map((doc) => ({ ref: doc.ref, type: 'delete' as const })),
    ...items.map((item) => {
      const { id, ...data } = item;
      return { ref: colRef.doc(id), type: 'set' as const, data: stripUndefined(data) };
    }),
  ];

  // Firestore allows max 500 operations per batch; use 400 to stay safe
  const BATCH_LIMIT = 400;
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const chunk = ops.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    for (const op of chunk) {
      if (op.type === 'delete') {
        batch.delete(op.ref);
      } else {
        batch.set(op.ref, op.data);
      }
    }
    await batch.commit();
  }
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
    throw error;
  }
}

const AUTO_REFRESH_DOC = 'autoRefresh/config';

export async function getAutoRefreshEnabled(): Promise<boolean> {
  try {
    const db = getDb();
    const doc = await db.doc(AUTO_REFRESH_DOC).get();
    if (!doc.exists) return true;
    const data = doc.data() || {};
    return data.enabled !== false;
  } catch (error) {
    logger.error({ error }, 'Failed to read autoRefresh config');
    return true;
  }
}

export async function setAutoRefreshEnabled(enabled: boolean): Promise<void> {
  const db = getDb();
  await db.doc(AUTO_REFRESH_DOC).set({ enabled: Boolean(enabled), updatedAt: Date.now() }, { merge: true });
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

export async function getCollectionCounts(): Promise<Record<string, number>> {
  try {
    const counts: Record<string, number> = {};
    const collections_to_count = [
      { key: 'movies', ref: collections.movies() },
      { key: 'series', ref: collections.series() },
      { key: 'estrenoMovies', ref: collections.estrenoMovies() },
      { key: 'estrenoSeries', ref: collections.estrenoSeries() },
      { key: 'channels', ref: collections.channels() },
      { key: 'popularMovies', ref: collections.popularMovies() },
      { key: 'popularSeries', ref: collections.popularSeries() },
    ];
    const results = await Promise.all(
      collections_to_count.map(async ({ key, ref }) => {
        try {
          const docs = await ref.listDocuments();
          return { key, count: docs.length };
        } catch {
          return { key, count: 0 };
        }
      }),
    );
    for (const { key, count } of results) {
      counts[key] = count;
    }
    // Combined counts
    counts['all'] = (counts['movies'] ?? 0) + (counts['series'] ?? 0);
    // Alias counts for cards that share the same collection
    counts['importM3U'] = counts['channels'] ?? 0;
    counts['refreshAll'] = counts['channels'] ?? 0;
    counts['refreshExpired'] = counts['channels'] ?? 0;
    return counts;
  } catch (error) {
    logger.error({ error }, 'Failed to get collection counts');
    return {};
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
