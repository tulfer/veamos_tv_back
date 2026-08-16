import { getRow, getRowStrict, setRow, storeKeys } from './store';
import { replaceCollection } from './data-store';
import { logger } from '../utils/logger';

/**
 * Backups de la base de datos (tabla `store`).
 *
 * Cada backup se guarda como una fila `backup:<id>` con el dump completo
 * (todas las colecciones + sync-meta) y el índice de backups en
 * `backups:index` (metadatos livianos para listar).
 *
 *   backup:<id>        -> BackupDump
 *   backups:index      -> BackupMeta[]
 */

export const BACKUP_COLLECTIONS = [
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

export const BACKUP_COLLECTION_LABELS: Record<string, string> = {
  movies: 'Películas',
  series: 'Series',
  channels: 'Canales',
  'popular-movies': 'Populares (M)',
  'popular-series': 'Populares (S)',
  'estreno-movies': 'Estrenos (M)',
  'estreno-series': 'Estrenos (S)',
  'gnulahd-movies': 'GNULA Películas',
  'gnulahd-series': 'GNULA Series',
  'gnulahd-anime': 'GNULA Anime',
};

export interface BackupMeta {
  id: string;
  createdAt: number;
  counts: Record<string, number>;
}

export interface BackupDump {
  version: number;
  createdAt: number;
  collections: Record<string, unknown[]>;
  syncMeta?: { updatedAt?: number } | null;
}

const INDEX_KEY = 'backups:index';
const BACKUP_KEY_PREFIX = 'backup:';
const MAX_BACKUPS = 20;

function backupKey(id: string): string {
  return BACKUP_KEY_PREFIX + id;
}

export async function listBackups(): Promise<BackupMeta[]> {
  try {
    const idx = await getRow<BackupMeta[]>(INDEX_KEY);
    return Array.isArray(idx) ? idx : [];
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'backups: no se pudo listar');
    return [];
  }
}

export async function getBackup(id: string): Promise<BackupDump | null> {
  try {
    const raw = await getRowStrict<BackupDump>(backupKey(id));
    return raw || null;
  } catch (error) {
    logger.error({ error: (error as Error).message, id }, 'backups: no se pudo leer el backup');
    return null;
  }
}

function countCollection(collections: Record<string, unknown[]>, key: string): number {
  const value = collections[key];
  return Array.isArray(value) ? value.length : 0;
}

/** Crea un backup completo de todas las colecciones. Si alguna lectura falla, lanza. */
export async function createBackup(): Promise<BackupMeta> {
  const [movies, series, channels, popularMovies, popularSeries, estrenoMovies, estrenoSeries, gnulahdMovies, gnulahdSeries, gnulahdAnime, syncMeta] = await Promise.all([
    getRowStrict<unknown[]>(storeKeys.collection('movies')),
    getRowStrict<unknown[]>(storeKeys.collection('series')),
    getRowStrict<unknown[]>(storeKeys.collection('channels')),
    getRowStrict<unknown[]>(storeKeys.collection('popular-movies')),
    getRowStrict<unknown[]>(storeKeys.collection('popular-series')),
    getRowStrict<unknown[]>(storeKeys.collection('estreno-movies')),
    getRowStrict<unknown[]>(storeKeys.collection('estreno-series')),
    getRowStrict<unknown[]>(storeKeys.collection('gnulahd-movies')),
    getRowStrict<unknown[]>(storeKeys.collection('gnulahd-series')),
    getRowStrict<unknown[]>(storeKeys.collection('gnulahd-anime')),
    getRowStrict<{ updatedAt?: number }>(storeKeys.syncMeta),
  ]);

  const collections: Record<string, unknown[]> = {
    movies: movies ?? [],
    series: series ?? [],
    channels: channels ?? [],
    'popular-movies': popularMovies ?? [],
    'popular-series': popularSeries ?? [],
    'estreno-movies': estrenoMovies ?? [],
    'estreno-series': estrenoSeries ?? [],
    'gnulahd-movies': gnulahdMovies ?? [],
    'gnulahd-series': gnulahdSeries ?? [],
    'gnulahd-anime': gnulahdAnime ?? [],
  };

  const dump: BackupDump = { version: 1, createdAt: Date.now(), collections, syncMeta: syncMeta ?? null };
  const id = `backup-${dump.createdAt}`;
  await setRow(backupKey(id), dump);

  const counts: Record<string, number> = {};
  for (const key of BACKUP_COLLECTIONS) counts[key] = countCollection(collections, key);
  const meta: BackupMeta = { id, createdAt: dump.createdAt, counts };

  const idx = await listBackups();
  const next = [meta, ...idx.filter((b) => b.id !== id)].slice(0, MAX_BACKUPS);
  await setRow(INDEX_KEY, next);

  logger.info({ id, counts }, 'Backup creado');
  return meta;
}

export interface RestoreResult {
  restored: string[];
  counts: Record<string, number>;
}

/** Restaura un dump. Si `collections` viene con claves, restaura solo esas;
 *  si viene vacío/ausente, restaura todas las que traiga el dump (+ sync-meta). */
export async function restoreBackup(dump: BackupDump, collections?: string[]): Promise<RestoreResult> {
  if (!dump || typeof dump !== 'object' || !dump.collections || typeof dump.collections !== 'object') {
    throw new Error('Formato de backup inválido');
  }
  const allowed = new Set<string>(BACKUP_COLLECTIONS);
  const requested = collections?.filter((c) => allowed.has(c)) ?? [];
  const targets = requested.length > 0
    ? requested
    : BACKUP_COLLECTIONS.filter((c) => Array.isArray(dump.collections[c]));

  const restored: string[] = [];
  const counts: Record<string, number> = {};
  for (const key of targets) {
    const items = Array.isArray(dump.collections[key]) ? dump.collections[key] : [];
    await replaceCollection(key, items);
    counts[key] = items.length;
    restored.push(key);
  }

  if (requested.length === 0 && dump.syncMeta && typeof dump.syncMeta === 'object') {
    await setRow(storeKeys.syncMeta, dump.syncMeta);
  }

  logger.info({ restored, counts }, 'Backup restaurado');
  return { restored, counts };
}
