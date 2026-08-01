import admin from 'firebase-admin';
import { getFirestore } from '../config/firebase';
import { collections } from './firestore';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { SyncData, SyncMovie, SyncSeries, LiveChannel, MediaItem } from '../types';

const SYNC_DATA_CACHE_KEY = 'sync:data';
const SYNC_DATA_CACHE_TTL_MS = 6 * 60 * 60_000;
const CHANNELS_CACHE_KEY = 'live:channels:data';
const CHANNELS_CACHE_TTL_MS = 6 * 60 * 60_000;
const COUNTS_CACHE_KEY = 'sync:counts';
const COUNTS_CACHE_TTL_MS = 5 * 60_000;
const COUNTS_PER_KEY_PREFIX = 'sync:count:';
const COUNTS_PER_KEY_TTL_MS = 60_000;

const COUNTABLE_COLLECTIONS: Record<string, () => admin.firestore.CollectionReference> = {
  movies: () => collections.movies(),
  series: () => collections.series(),
  estrenoMovies: () => collections.estrenoMovies(),
  estrenoSeries: () => collections.estrenoSeries(),
  channels: () => collections.channels(),
  popularMovies: () => collections.popularMovies(),
  popularSeries: () => collections.popularSeries(),
};

/** Clon profundo: evita que los handlers muten el snapshot cacheado
 *  (la data sincronizada solo cambia vía saveSyncData, que invalida el caché). */
function cloneDeep<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

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
  const db = getDb();

  const newIds = new Set(items.map((item) => item.id));
  const ops: Array<{ ref: admin.firestore.DocumentReference; type: 'delete' | 'set'; data?: unknown }> = [];

  // Usar listDocuments (solo referencias/IDs) en vez de get() (docs completos):
  // cada sync lee mucho menos de Firestore. Si falla, se omite el borrado de huérfanos.
  try {
    const existingRefs = await colRef.listDocuments();
    for (const ref of existingRefs) {
      if (!newIds.has(ref.id)) {
        ops.push({ ref, type: 'delete' as const });
      }
    }
  } catch (error) {
    logger.warn({ error: (error as Error).message, col: colRef.id }, 'replaceCollection: no se pudieron listar existentes, se omiten borrados');
  }

  for (const item of items) {
    const { id, ...data } = item;
    ops.push({ ref: colRef.doc(id), type: 'set' as const, data: stripUndefined(data) });
  }

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
  const cached = memoryCache.get<SyncData>(SYNC_DATA_CACHE_KEY);
  if (cached) return cloneDeep(cached);

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

    const result: SyncData = {
      movies,
      series,
      channels,
      popularMovies,
      popularSeries,
      estrenoMovies,
      estrenoSeries,
      updatedAt: meta?.updatedAt ?? Date.now(),
    };

    memoryCache.set(SYNC_DATA_CACHE_KEY, result, SYNC_DATA_CACHE_TTL_MS);
    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to load sync data from Firestore');
    return null;
  }
}

/** Carga solo la colección de canales (barata), con caché en memoria para no
 *  leer Firestore en cada request de /live/channels. */
export async function loadChannels(): Promise<LiveChannel[]> {
  const cached = memoryCache.get<LiveChannel[]>(CHANNELS_CACHE_KEY);
  if (cached) return cloneDeep(cached);

  const channels = await getCollectionAsArray<LiveChannel>(collections.channels());
  memoryCache.set(CHANNELS_CACHE_KEY, channels, CHANNELS_CACHE_TTL_MS);
  return channels;
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
    memoryCache.del(SYNC_DATA_CACHE_KEY);
    memoryCache.del(CHANNELS_CACHE_KEY);
    memoryCache.del(COUNTS_CACHE_KEY);
    for (const key of Object.keys(COUNTABLE_COLLECTIONS)) {
      memoryCache.del(COUNTS_PER_KEY_PREFIX + key);
    }
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

export interface AutoRefreshConfig {
  enabled: boolean;
  intervalMinutes: number;
}

const DEFAULT_AUTO_REFRESH: AutoRefreshConfig = { enabled: true, intervalMinutes: 5 };

function normalizeInterval(interval: unknown): number {
  const n = Number(interval);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_AUTO_REFRESH.intervalMinutes;
}

export async function getAutoRefreshConfig(): Promise<AutoRefreshConfig> {
  try {
    const db = getDb();
    const doc = await db.doc(AUTO_REFRESH_DOC).get();
    if (!doc.exists) return { ...DEFAULT_AUTO_REFRESH };
    const data = doc.data() || {};
    return {
      enabled: data.enabled !== false,
      intervalMinutes: normalizeInterval(data.intervalMinutes),
    };
  } catch (error) {
    logger.error({ error }, 'Failed to read autoRefresh config');
    return { ...DEFAULT_AUTO_REFRESH };
  }
}

export async function setAutoRefreshConfig(config: { enabled?: boolean; intervalMinutes?: number }): Promise<AutoRefreshConfig> {
  const current = await getAutoRefreshConfig();
  const next: AutoRefreshConfig = {
    enabled: config.enabled !== undefined ? Boolean(config.enabled) : current.enabled,
    intervalMinutes: config.intervalMinutes !== undefined ? normalizeInterval(config.intervalMinutes) : current.intervalMinutes,
  };
  const db = getDb();
  await db.doc(AUTO_REFRESH_DOC).set({ enabled: next.enabled, intervalMinutes: next.intervalMinutes, updatedAt: Date.now() }, { merge: true });
  return next;
}

export async function setAutoRefreshLastRunAt(timestamp: number): Promise<void> {
  const db = getDb();
  await db.doc(AUTO_REFRESH_DOC).set({ lastRunAt: timestamp }, { merge: true });
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
  const cached = memoryCache.get<Record<string, number>>(COUNTS_CACHE_KEY);
  if (cached) return cached;

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
    memoryCache.set(COUNTS_CACHE_KEY, counts, COUNTS_CACHE_TTL_MS);
    return counts;
  } catch (error) {
    logger.error({ error }, 'Failed to get collection counts');
    return {};
  }
}

/** Cuenta una sola colección (1 lectura) con caché por clave. */
export async function getCollectionCount(key: string): Promise<number | null> {
  const cacheKey = COUNTS_PER_KEY_PREFIX + key;
  const cached = memoryCache.get<number>(cacheKey);
  if (cached != null) return cached;

  const getRef = COUNTABLE_COLLECTIONS[key];
  if (!getRef) return null;

  try {
    const docs = await getRef().listDocuments();
    memoryCache.set(cacheKey, docs.length, COUNTS_PER_KEY_TTL_MS);
    return docs.length;
  } catch (error) {
    logger.error({ error, key }, 'Failed to count collection');
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
