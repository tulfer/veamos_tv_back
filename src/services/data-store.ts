import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { SyncData, SyncMovie, SyncSeries, LiveChannel, MediaItem } from '../types';
import { storeKeys, getRow, setRow } from './store';
import { toPublicProxyUrl } from '../utils/proxy-url';

const SYNC_DATA_CACHE_KEY = 'sync:data';
const SYNC_DATA_CACHE_TTL_MS = 6 * 60 * 60_000;
const CHANNELS_CACHE_KEY = 'live:channels:data';
const CHANNELS_CACHE_TTL_MS = 6 * 60 * 60_000;
const COUNTS_CACHE_KEY = 'sync:counts';
const COUNTS_CACHE_TTL_MS = 5 * 60_000;
const COUNTS_PER_KEY_PREFIX = 'sync:count:';
const COUNTS_PER_KEY_TTL_MS = 60_000;

const COLLECTION_KEYS = [
  'movies',
  'series',
  'channels',
  'popular-movies',
  'popular-series',
  'estreno-movies',
  'estreno-series',
  'gnulahd-movies',
  'gnulahd-series',
  'gnulahd-anime',
] as const;

// /sync/count/:type recibe nombres camelCase (los del dashboard).
const TYPE_TO_COLLECTION_KEY: Record<string, string> = {
  movies: 'movies',
  series: 'series',
  channels: 'channels',
  estrenoMovies: 'estreno-movies',
  estrenoSeries: 'estreno-series',
  popularMovies: 'popular-movies',
  popularSeries: 'popular-series',
  gnulahdMovies: 'gnulahd-movies',
  gnulahdSeries: 'gnulahd-series',
  gnulahdAnime: 'gnulahd-anime',
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

async function loadCollection<T>(name: string): Promise<T[]> {
  const data = await getRow<T[]>(storeKeys.collection(name));
  return Array.isArray(data) ? data : [];
}

async function saveCollection<T>(name: string, items: T[]): Promise<void> {
  await setRow(storeKeys.collection(name), stripUndefined(items));
}

export async function loadSyncData(): Promise<SyncData | null> {
  const cached = memoryCache.get<SyncData>(SYNC_DATA_CACHE_KEY);
  if (cached) return cloneDeep(cached);

  const [movies, series, channels, popularMovies, popularSeries, estrenoMovies, estrenoSeries, gnulahdMovies, gnulahdSeries, gnulahdAnime, meta] =
    await Promise.all([
      loadCollection<SyncMovie>('movies'),
      loadCollection<SyncSeries>('series'),
      loadCollection<LiveChannel>('channels'),
      loadCollection<MediaItem>('popular-movies'),
      loadCollection<MediaItem>('popular-series'),
      loadCollection<SyncMovie>('estreno-movies'),
      loadCollection<SyncSeries>('estreno-series'),
      loadCollection<SyncMovie>('gnulahd-movies'),
      loadCollection<SyncSeries>('gnulahd-series'),
      loadCollection<SyncSeries>('gnulahd-anime'),
      getRow<{ updatedAt?: number }>(storeKeys.syncMeta),
    ]);

  const result: SyncData = {
    movies,
    series,
    channels: channels.map((c) => (c?.url ? { ...c, url: toPublicProxyUrl(c.url) } : c)),
    popularMovies,
    popularSeries,
    estrenoMovies,
    estrenoSeries,
    gnulahdMovies,
    gnulahdSeries,
    gnulahdAnime,
    updatedAt: meta?.updatedAt ?? Date.now(),
  };

  memoryCache.set(SYNC_DATA_CACHE_KEY, result, SYNC_DATA_CACHE_TTL_MS);
  return result;
}

/** Carga solo la colección de canales (barata), con caché en memoria para no
 *  leer la base en cada request de /live/channels. */
export async function loadChannels(): Promise<LiveChannel[]> {
  const cached = memoryCache.get<LiveChannel[]>(CHANNELS_CACHE_KEY);
  if (cached) return cloneDeep(cached);

  const channels = await loadCollection<LiveChannel>('channels');
  const normalized = channels.map((c) => (c?.url ? { ...c, url: toPublicProxyUrl(c.url) } : c));
  memoryCache.set(CHANNELS_CACHE_KEY, normalized, CHANNELS_CACHE_TTL_MS);
  return normalized;
}

export async function saveSyncData(data: SyncData): Promise<void> {
  try {
    await Promise.all([
      saveCollection('movies', data.movies),
      saveCollection('series', data.series),
      saveCollection('channels', data.channels),
      saveCollection('popular-movies', data.popularMovies),
      saveCollection('popular-series', data.popularSeries),
      saveCollection('estreno-movies', data.estrenoMovies),
      saveCollection('estreno-series', data.estrenoSeries),
      saveCollection('gnulahd-movies', data.gnulahdMovies || []),
      saveCollection('gnulahd-series', data.gnulahdSeries || []),
      saveCollection('gnulahd-anime', data.gnulahdAnime || []),
      setRow(storeKeys.syncMeta, { updatedAt: data.updatedAt }),
    ]);
    memoryCache.del(SYNC_DATA_CACHE_KEY);
    memoryCache.del(CHANNELS_CACHE_KEY);
    memoryCache.del(COUNTS_CACHE_KEY);
    for (const key of Object.keys(TYPE_TO_COLLECTION_KEY)) {
      memoryCache.del(COUNTS_PER_KEY_PREFIX + key);
    }
    logger.info(
      { movies: data.movies.length, series: data.series.length, channels: data.channels.length },
      'Sync data saved to database',
    );
  } catch (error) {
    logger.error({ error }, 'Failed to save sync data to database');
    throw error;
  }
}

const DEFAULT_AUTO_REFRESH = { enabled: true, intervalMinutes: 5 };

export interface AutoRefreshConfig {
  enabled: boolean;
  intervalMinutes: number;
}

function normalizeInterval(interval: unknown): number {
  const n = Number(interval);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_AUTO_REFRESH.intervalMinutes;
}

export async function getAutoRefreshConfig(): Promise<AutoRefreshConfig> {
  try {
    const data = await getRow<AutoRefreshConfig>(storeKeys.autoRefresh);
    if (!data) return { ...DEFAULT_AUTO_REFRESH };
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
  await setRow(storeKeys.autoRefresh, { ...next, updatedAt: Date.now() });
  return next;
}

export async function setAutoRefreshLastRunAt(timestamp: number): Promise<void> {
  const current = await getRow<Record<string, unknown>>(storeKeys.autoRefresh);
  await setRow(storeKeys.autoRefresh, { ...(current || {}), lastRunAt: timestamp, updatedAt: Date.now() });
}

export async function getSyncStats(): Promise<{
  movies: number;
  series: number;
  channels: number;
  updatedAt: number | null;
} | null> {
  try {
    const [movies, series, channels, meta] = await Promise.all([
      loadCollection<SyncMovie>('movies'),
      loadCollection<SyncSeries>('series'),
      loadCollection<LiveChannel>('channels'),
      getRow<{ updatedAt?: number }>(storeKeys.syncMeta),
    ]);
    return {
      movies: movies.length,
      series: series.length,
      channels: channels.length,
      updatedAt: meta?.updatedAt ?? null,
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
    const [movies, series, estrenoMovies, estrenoSeries, channels, popularMovies, popularSeries, gnulahdMovies, gnulahdSeries, gnulahdAnime] = await Promise.all([
      loadCollection<SyncMovie>('movies'),
      loadCollection<SyncSeries>('series'),
      loadCollection<SyncMovie>('estreno-movies'),
      loadCollection<SyncSeries>('estreno-series'),
      loadCollection<LiveChannel>('channels'),
      loadCollection<MediaItem>('popular-movies'),
      loadCollection<MediaItem>('popular-series'),
      loadCollection<SyncMovie>('gnulahd-movies'),
      loadCollection<SyncSeries>('gnulahd-series'),
      loadCollection<SyncSeries>('gnulahd-anime'),
    ]);
    counts['movies'] = movies.length;
    counts['series'] = series.length;
    counts['estrenoMovies'] = estrenoMovies.length;
    counts['estrenoSeries'] = estrenoSeries.length;
    counts['channels'] = channels.length;
    counts['popularMovies'] = popularMovies.length;
    counts['popularSeries'] = popularSeries.length;
    counts['gnulahdMovies'] = gnulahdMovies.length;
    counts['gnulahdSeries'] = gnulahdSeries.length;
    counts['gnulahdAnime'] = gnulahdAnime.length;
    counts['all'] = counts['movies'] + counts['series'];
    counts['importM3U'] = counts['channels'];
    counts['refreshAll'] = counts['channels'];
    counts['refreshExpired'] = counts['channels'];
    memoryCache.set(COUNTS_CACHE_KEY, counts, COUNTS_CACHE_TTL_MS);
    return counts;
  } catch (error) {
    logger.error({ error }, 'Failed to get collection counts');
    return {};
  }
}

/** Cuenta una sola colección (1 lectura) con caché por clave. */
export async function getCollectionCount(key: string): Promise<number | null> {
  const collectionKey = TYPE_TO_COLLECTION_KEY[key];
  if (!collectionKey) return null;
  const cacheKey = COUNTS_PER_KEY_PREFIX + key;
  const cached = memoryCache.get<number>(cacheKey);
  if (cached != null) return cached;
  try {
    const items = await loadCollection<unknown>(collectionKey);
    memoryCache.set(cacheKey, items.length, COUNTS_PER_KEY_TTL_MS);
    return items.length;
  } catch (error) {
    logger.error({ error, key }, 'Failed to count collection');
    return null;
  }
}

// ---- Documento individual (self-healing del detalle) ----

/** Actualiza (o crea) un item dentro de una colección por su id. */
export async function upsertItemByCol<T extends { id: string }>(collection: string, item: T): Promise<void> {
  const items = await loadCollection<T>(collection);
  const { id, ...data } = item;
  const idx = items.findIndex((i) => i.id === id);
  const clean = stripUndefined(data);
  if (idx >= 0) {
    items[idx] = { id, ...clean } as unknown as T;
  } else {
    items.push({ id, ...clean } as unknown as T);
  }
  await setRow(storeKeys.collection(collection), items);
}

export async function loadHomeData<T = unknown>(): Promise<T | null> {
  try {
    return await getRow<T>(storeKeys.home);
  } catch (error) {
    logger.error({ error }, 'Failed to load home data');
    return null;
  }
}

export async function saveHomeData(data: Record<string, unknown>): Promise<void> {
  try {
    await setRow(storeKeys.home, { ...data, updatedAt: Date.now() });
    logger.info('Home data saved');
  } catch (error) {
    logger.error({ error }, 'Failed to save home data');
  }
}