import { getPool, getRow, setRow, deleteRow } from '../../services/store';
import { memoryCache } from '../../cache/memory';
import { logger } from '../../utils/logger';

/**
 * Capa de servicio del Explorador de Base de Datos.
 *
 * Opera directamente sobre la tabla `store` (key -> value jsonb). Cada fila
 * es una "colección" o un "documento" (sync-meta, user:<uid>, home:*, etc.).
 * Las escrituras invalidan los mismos cachés que saveSyncData para que la
 * app refleje los cambios de inmediato.
 */

export interface StoreKeyInfo {
  key: string;
  updatedAt: string | null;
  type: 'array' | 'object' | 'string' | 'number' | 'boolean' | 'null' | 'unknown';
  count: number | null;
  sizeBytes: number | null;
}

export async function listStoreKeys(): Promise<StoreKeyInfo[]> {
  const p = getPool();
  if (!p) return [];
  try {
    const { rows } = await p.query(`
      SELECT key,
             to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at,
             jsonb_typeof(value) AS vtype,
             CASE WHEN jsonb_typeof(value) = 'array' THEN jsonb_array_length(value) END AS cnt,
             pg_column_size(value) AS size_bytes
      FROM store
      ORDER BY key ASC
    `);
    return rows.map((r) => ({
      key: r.key as string,
      updatedAt: (r.updated_at as string | null) ?? null,
      type: (r.vtype || 'unknown') as StoreKeyInfo['type'],
      count: r.cnt != null ? Number(r.cnt) : null,
      sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
    }));
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'db-explorer: listStoreKeys failed');
    return [];
  }
}

export async function loadCollectionRaw(key: string): Promise<unknown | null> {
  return getRow<unknown>(key);
}

// ---- Mutación de rutas JSON ----

const MAX_PATH_DEPTH = 40;
const FORBIDDEN_SEGMENTS = ['__proto__', 'constructor', 'prototype'];

export function parsePathSegments(raw: unknown): (string | number)[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PATH_DEPTH) return null;
  const segments: (string | number)[] = [];
  for (const s of raw) {
    if (typeof s === 'number' && Number.isInteger(s) && s >= 0) {
      segments.push(s);
      continue;
    }
    if (typeof s === 'string' && s.length > 0 && s.length <= 200 && !FORBIDDEN_SEGMENTS.includes(s)) {
      segments.push(s);
      continue;
    }
    return null;
  }
  return segments;
}

function cloneDeep<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/** Recorre el árbol creando objetos/arrays intermedios si no existen y fija el valor. */
export function applyPathSet(root: unknown, segments: (string | number)[], value: unknown): unknown {
  const target = cloneDeep(root) as any;
  let node: any = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    let next = node[seg];
    if (next === null || typeof next !== 'object') {
      next = typeof segments[i + 1] === 'number' ? [] : {};
      node[seg] = next;
    }
    node = next;
  }
  node[segments[segments.length - 1]] = value;
  return target;
}

/** Elimina una clave (objeto) o un índice (array). Si la ruta no existe, devuelve el mismo árbol. */
export function applyPathDelete(root: unknown, segments: (string | number)[]): unknown {
  const target = cloneDeep(root) as any;
  let node: any = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (node === null || typeof node !== 'object' || !(seg in node)) return root;
    node = node[seg];
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(node) && typeof last === 'number') {
    if (last >= 0 && last < node.length) node.splice(last, 1);
  } else if (node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, last)) {
    delete node[last];
  }
  return target;
}

// ---- Persistencia ----

const COUNT_KEYS = [
  'movies', 'series', 'channels', 'estrenoMovies', 'estrenoSeries',
  'popularMovies', 'popularSeries', 'gnulahdMovies', 'gnulahdSeries', 'gnulahdAnime',
];

export async function saveCollectionRaw(key: string, value: unknown): Promise<void> {
  await setRow(key, value);
  // Invalida los mismos cachés que saveSyncData.
  memoryCache.del('sync:data');
  memoryCache.del('live:channels:data');
  memoryCache.del('sync:counts');
  for (const k of COUNT_KEYS) {
    memoryCache.del('sync:count:' + k);
  }
  logger.info({ key }, 'db-explorer: collection updated');
}

export async function deleteCollectionRaw(key: string): Promise<void> {
  await deleteRow(key);
  memoryCache.del('sync:data');
  memoryCache.del('live:channels:data');
  memoryCache.del('sync:counts');
  for (const k of COUNT_KEYS) {
    memoryCache.del('sync:count:' + k);
  }
  logger.info({ key }, 'db-explorer: collection deleted');
}
