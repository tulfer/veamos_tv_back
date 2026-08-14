import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { SyncData, SyncMovie, SyncSeries, LiveChannel, MediaItem } from '../types';
import { storeKeys, getRow, getRowStrict, setRow } from './store';
import { toPublicProxyUrl } from '../utils/proxy-url';

const SYNC_DATA_CACHE_KEY = 'sync:data';
const SYNC_DATA_CACHE_TTL_MS = 6 * 60 * 60_000;
const CHANNELS_CACHE_KEY = 'live:channels:data';
const CHANNELS_CACHE_TTL_MS = 6 * 60 * 60_000;
const COUNTS_CACHE_KEY = 'sync:counts';
const COUNTS_CACHE_TTL_MS = 5 * 60_000;
const COUNTS_PER_KEY_PREFIX = 'sync:count:';
const COUNTS_PER_KEY_TTL_MS = 60_000;

const PROVIDER_ID_PREFIXES: Record<string, string> = {
  wsdeportes: 'wsd',
  cablevisionhd: 'cvh',
  tvporinternet2: 'tpi2',
  tvenvivo2: 'tve2',
  chatytv: 'ctv',
  senalcolombia: 'sc',
  vertvcable: 'vtc',
};

export function getProviderChannelId(provider: string | undefined, slug: string): string {
  const prefix = PROVIDER_ID_PREFIXES[provider || ''] || provider || 'live';
  const safeSlug = slug.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return `live_${prefix}_${safeSlug || 'channel'}`;
}

function providerFromChannel(channel: LiveChannel): string | undefined {
  if (channel.proveedor && PROVIDER_ID_PREFIXES[channel.proveedor]) return channel.proveedor;
  const url = channel.refreshUrl || '';
  if (url.includes('wsdeportes.net')) return 'wsdeportes';
  if (url.includes('cablevisionhd.com')) return 'cablevisionhd';
  if (url.includes('tvporinternet2.com')) return 'tvporinternet2';
  if (url.includes('tvenvivo2.com')) return 'tvenvivo2';
  if (url.includes('chatytvgratis.net')) return 'chatytv';
  if (url.includes('senalcolombia.tv')) return 'senalcolombia';
  if (url.includes('vertvcable.com')) return 'vertvcable';
  return undefined;
}

function slugFromChannel(channel: LiveChannel): string {
  try {
    const parsed = new URL(channel.refreshUrl || '');
    const querySlug = parsed.searchParams.get('v');
    if (querySlug) return querySlug;
    const path = parsed.pathname.split('/').filter(Boolean).pop() || '';
    if (path) return path.replace(/\.php$/i, '');
  } catch {
    // Se usa el id legado como respaldo.
  }
  return channel.id.replace(/^live_/, '');
}

/** Migra IDs legacy live_<slug> a IDs con proveedor, evitando colisiones. */
export async function migrateProviderChannelIds(): Promise<number> {
  const channels = await loadCollection<LiveChannel>('channels');
  const used = new Set<string>();
  let changed = 0;
  const migrated = channels.map((channel) => {
    const provider = providerFromChannel(channel);
    if (!provider || channel.id.startsWith(`live_${PROVIDER_ID_PREFIXES[provider]}_`)) {
      used.add(channel.id);
      return channel;
    }
    const baseId = getProviderChannelId(provider, slugFromChannel(channel));
    let id = baseId;
    let suffix = 2;
    while (used.has(id)) id = `${baseId}_${suffix++}`;
    used.add(id);
    changed++;
    return { ...channel, id, proveedor: channel.proveedor || provider };
  });

  if (changed > 0) {
    await saveCollection('channels', migrated);
    memoryCache.del(SYNC_DATA_CACHE_KEY);
    memoryCache.del(CHANNELS_CACHE_KEY);
    logger.info({ changed }, 'Provider-scoped channel IDs migrated');
  }
  return changed;
}

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

/** Igual que loadCollection pero Lanza ante errores de red/BD: ante un fallo
 *  de lectura es preferible abortar la escritura que reescribir la colección
 *  completa con datos parciales (eso borraría items existentes). */
async function loadCollectionStrict<T>(name: string): Promise<T[]> {
  const data = await getRowStrict<T[]>(storeKeys.collection(name));
  return Array.isArray(data) ? data : [];
}

/** Lee una colección completa desde la BD sin caché (para listar items). */
export async function listCollection<T>(name: string): Promise<T[]> {
  return loadCollection<T>(name);
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
    // Las colecciones GNULA se re-leen live desde la BD ANTES de escribir:
    // así un sync v1 (canales/películas) nunca pisa datos recién sincronizados.
    // Si la lectura falla (red/BD), se omite el guardado de GNULA (no se tocan)
    // en vez de reescribirlas vacías/parciales y borrar items. (bug "se borran los animes")
    let gnulahdMovies: SyncMovie[] | null = null;
    let gnulahdSeries: SyncSeries[] | null = null;
    let gnulahdAnime: SyncSeries[] | null = null;
    try {
      const [liveGnuMovies, liveGnuSeries, liveGnuAnime] = await Promise.all([
        getRowStrict<SyncMovie[]>(storeKeys.collection('gnulahd-movies')),
        getRowStrict<SyncSeries[]>(storeKeys.collection('gnulahd-series')),
        getRowStrict<SyncSeries[]>(storeKeys.collection('gnulahd-anime')),
      ]);
      gnulahdMovies = liveGnuMovies ?? [];
      gnulahdSeries = liveGnuSeries ?? [];
      gnulahdAnime = liveGnuAnime ?? [];
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'No se pudo leer colecciones GNULA; se omiten estas colecciones en el guardado');
    }
    const writes = [
      saveCollection('movies', data.movies),
      saveCollection('series', data.series),
      saveCollection('channels', data.channels),
      saveCollection('popular-movies', data.popularMovies),
      saveCollection('popular-series', data.popularSeries),
      saveCollection('estreno-movies', data.estrenoMovies),
      saveCollection('estreno-series', data.estrenoSeries),
      setRow(storeKeys.syncMeta, { updatedAt: data.updatedAt }),
    ];
    if (gnulahdMovies !== null) writes.push(saveCollection('gnulahd-movies', gnulahdMovies));
    if (gnulahdSeries !== null) writes.push(saveCollection('gnulahd-series', gnulahdSeries));
    if (gnulahdAnime !== null) writes.push(saveCollection('gnulahd-anime', gnulahdAnime));
    await Promise.all(writes);
    memoryCache.del(SYNC_DATA_CACHE_KEY);
    memoryCache.del(CHANNELS_CACHE_KEY);
    memoryCache.del(COUNTS_CACHE_KEY);
    for (const key of Object.keys(TYPE_TO_COLLECTION_KEY)) {
      memoryCache.del(COUNTS_PER_KEY_PREFIX + key);
    }
    logger.info(
      {
        movies: data.movies.length,
        series: data.series.length,
        channels: data.channels.length,
        gnulahdMovies: gnulahdMovies.length,
        gnulahdSeries: gnulahdSeries.length,
        gnulahdAnime: gnulahdAnime.length,
      },
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
  /** proveedor -> intervalo en minutos (solo proveedores activos) */
  providers: Record<string, number>;
  /** proveedor -> timestamp (ms) de la última ejecución automática */
  providerLastRuns: Record<string, number>;
  /** compat: última ejecución global (la escribía el cron externo) */
  lastRunAt?: number;
  updatedAt?: number;
}

function normalizeInterval(interval: unknown): number {
  const n = Number(interval);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_AUTO_REFRESH.intervalMinutes;
}

function normalizeMinutesMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1) out[k] = Math.floor(n);
    }
  }
  return out;
}

function normalizeTimestampMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
    }
  }
  return out;
}

export async function getAutoRefreshConfig(): Promise<AutoRefreshConfig> {
  try {
    const data = await getRow<Partial<AutoRefreshConfig>>(storeKeys.autoRefresh);
    if (!data) return { ...DEFAULT_AUTO_REFRESH, providers: {}, providerLastRuns: {} };
    return {
      enabled: data.enabled !== false,
      intervalMinutes: normalizeInterval(data.intervalMinutes),
      providers: normalizeMinutesMap(data.providers),
      providerLastRuns: normalizeTimestampMap(data.providerLastRuns),
      lastRunAt: typeof data.lastRunAt === 'number' ? data.lastRunAt : undefined,
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : undefined,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to read autoRefresh config');
    return { ...DEFAULT_AUTO_REFRESH, providers: {}, providerLastRuns: {} };
  }
}

export async function setAutoRefreshConfig(config: { enabled?: boolean; intervalMinutes?: number; providers?: Record<string, number> }): Promise<AutoRefreshConfig> {
  const current = await getAutoRefreshConfig();
  const next: AutoRefreshConfig = {
    enabled: config.enabled !== undefined ? Boolean(config.enabled) : current.enabled,
    intervalMinutes: config.intervalMinutes !== undefined ? normalizeInterval(config.intervalMinutes) : current.intervalMinutes,
    providers: config.providers !== undefined ? normalizeMinutesMap(config.providers) : current.providers,
    providerLastRuns: current.providerLastRuns,
    lastRunAt: current.lastRunAt,
  };
  await setRow(storeKeys.autoRefresh, { ...next, updatedAt: Date.now() });
  return next;
}

export async function setAutoRefreshProviderLastRun(provider: string, timestamp: number): Promise<void> {
  const current = await getRow<Record<string, unknown>>(storeKeys.autoRefresh);
  const lastRuns = { ...((current?.providerLastRuns as Record<string, unknown>) || {}) };
  lastRuns[provider] = timestamp;
  await setRow(storeKeys.autoRefresh, {
    ...(current || {}),
    providerLastRuns: lastRuns,
    lastRunAt: timestamp,
    updatedAt: Date.now(),
  });
}

// ---- Autosync GNULA (home / movies / series / anime) ----

export const GNULAHD_AUTO_TASKS = ['home', 'movies', 'series', 'anime'] as const;
export type GnulahdAutoTask = (typeof GNULAHD_AUTO_TASKS)[number];

export interface GnulahdAutoTaskConfig {
  enabled: boolean;
  /** Intervalo en horas entre ejecuciones automáticas. */
  intervalHours: number;
  /** Páginas a sincronizar (solo kind: movies/series/anime). */
  pages?: string;
  lastRunAt?: number;
}

export interface GnulahdAutoSyncConfig {
  /** tasks: { home?, movies?, series?, anime? } según se hayan configurado. */
  tasks: Partial<Record<GnulahdAutoTask, GnulahdAutoTaskConfig>>;
  updatedAt?: number;
}

const DEFAULT_GNULAHD_TASK: GnulahdAutoTaskConfig = { enabled: false, intervalHours: 12, pages: '1-10' };

function normalizeGnulahdTaskConfig(value: unknown): GnulahdAutoTaskConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const hours = Number(raw.intervalHours);
  const pages = typeof raw.pages === 'string' && raw.pages.trim() ? raw.pages.trim() : undefined;
  const lastRunAt = typeof raw.lastRunAt === 'number' && raw.lastRunAt > 0 ? Math.floor(raw.lastRunAt) : undefined;
  return {
    enabled: raw.enabled === true,
    intervalHours: Number.isFinite(hours) && hours >= 0.1 ? hours : DEFAULT_GNULAHD_TASK.intervalHours,
    ...(pages ? { pages } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
  };
}

export async function getGnulahdAutoSyncConfig(): Promise<GnulahdAutoSyncConfig> {
  try {
    const data = await getRow<Partial<GnulahdAutoSyncConfig>>(storeKeys.gnulahdAutoSync);
    const tasks: GnulahdAutoSyncConfig['tasks'] = {};
    if (data?.tasks && typeof data.tasks === 'object') {
      for (const [task, cfg] of Object.entries(data.tasks)) {
        if (!GNULAHD_AUTO_TASKS.includes(task as GnulahdAutoTask)) continue;
        const normalized = normalizeGnulahdTaskConfig(cfg);
        if (normalized) tasks[task as GnulahdAutoTask] = normalized;
      }
    }
    return {
      tasks,
      updatedAt: typeof data?.updatedAt === 'number' ? data.updatedAt : undefined,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to read gnulahd auto-sync config');
    return { tasks: {} };
  }
}

export async function setGnulahdAutoSyncConfig(config: { tasks?: Partial<Record<GnulahdAutoTask, Partial<GnulahdAutoTaskConfig>>> }): Promise<GnulahdAutoSyncConfig> {
  const current = await getGnulahdAutoSyncConfig();
  const next: GnulahdAutoSyncConfig = { tasks: { ...current.tasks } };
  if (config.tasks) {
    for (const [task, patch] of Object.entries(config.tasks)) {
      if (!GNULAHD_AUTO_TASKS.includes(task as GnulahdAutoTask)) continue;
      const currentTask = current.tasks[task as GnulahdAutoTask] ?? { ...DEFAULT_GNULAHD_TASK };
      const hours = patch.intervalHours !== undefined ? patch.intervalHours : currentTask.intervalHours;
      next.tasks[task as GnulahdAutoTask] = {
        enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : currentTask.enabled,
        intervalHours: Number.isFinite(Number(hours)) && Number(hours) >= 0.1 ? Number(hours) : currentTask.intervalHours,
        ...(patch.pages !== undefined ? { pages: patch.pages.trim() ? patch.pages.trim() : '1-10' } : currentTask.pages ? { pages: currentTask.pages } : {}),
        ...(currentTask.lastRunAt ? { lastRunAt: currentTask.lastRunAt } : {}),
      };
    }
  }
  await setRow(storeKeys.gnulahdAutoSync, { ...next, updatedAt: Date.now() });
  return next;
}

export async function setGnulahdAutoSyncLastRun(task: GnulahdAutoTask, timestamp: number): Promise<void> {
  const current = await getGnulahdAutoSyncConfig();
  const currentTask = current.tasks[task] ?? { ...DEFAULT_GNULAHD_TASK };
  current.tasks[task] = {
    enabled: currentTask.enabled,
    intervalHours: currentTask.intervalHours,
    ...(currentTask.pages ? { pages: currentTask.pages } : {}),
    lastRunAt: timestamp,
  };
  await setRow(storeKeys.gnulahdAutoSync, { ...current, updatedAt: Date.now() });
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

/** Actualiza (o crea) un item dentro de una colección por su id.
 *  Si la lectura previa falla (red/BD), Lanza para no reescribir la
 *  colección entera con datos parciales (podría borrar items existentes). */
export async function upsertItemByCol<T extends { id: string }>(collection: string, item: T): Promise<void> {
  const items = await loadCollectionStrict<T>(collection);
  const byId = new Map(items.map((existing) => [existing.id, existing]));
  const { id, ...data } = item;
  byId.set(id, { id, ...stripUndefined(data) } as unknown as T);
  await setRow(storeKeys.collection(collection), Array.from(byId.values()));
}

/** Actualiza varios documentos en una sola lectura/escritura de la colección. */
export async function upsertItemsByCol<T extends { id: string }>(collection: string, newItems: T[]): Promise<void> {
  if (newItems.length === 0) return;
  const items = await loadCollectionStrict<T>(collection);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of newItems) {
    const { id, ...data } = item;
    byId.set(id, { id, ...stripUndefined(data) } as T);
  }
  await setRow(storeKeys.collection(collection), Array.from(byId.values()));
}

/** Reemplaza una colecciÃ³n completa y mantiene los cachÃ©s coherentes. */
export async function replaceCollection<T>(collection: string, items: T[]): Promise<void> {
  await setRow(storeKeys.collection(collection), stripUndefined(items));
  memoryCache.del(SYNC_DATA_CACHE_KEY);
  memoryCache.del(COUNTS_CACHE_KEY);
  for (const key of Object.keys(TYPE_TO_COLLECTION_KEY)) {
    memoryCache.del(COUNTS_PER_KEY_PREFIX + key);
  }
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
