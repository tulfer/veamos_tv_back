import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { env } from '../config/env';

/**
 * Capa de datos sobre Supabase (Postgres).
 *
 * Modelo fiel a Firestore: una sola tabla `store` de tipo llave-valor con
 * JSONB, donde cada fila representa "una colección entera" o "un documento".
 *
 *   store(key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz default now())
 *
 * Claves:
 *   'movies' | 'series' | 'channels' | 'popular-movies' | 'popular-series'
 *     | 'estreno-movies' | 'estreno-series'   -> value = array de items
 *   'sync-meta'                                -> value = { updatedAt }
 *   'auto:cfg'                                 -> value = config auto-refresh
 *   'home:cineby'                              -> value = datos del home
 *   'user:<uid>'                               -> value = perfil de usuario
 *   'fav:<uid>:<profile>'                      -> value = { items }
 *   'watch:<uid>:<profile>'                    -> value = { items }
 *   'hist:<uid>:<profile>'                     -> value = { items }
 *   'rec:<profile>'                            -> value = { items }
 */

let pool: Pool | null = null;

export function storeEnabled(): boolean {
  return !!env.DATABASE_URL;
}

export function getPool(): Pool | null {
  if (!env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30_000,
      max: 10,
    });
  }
  return pool;
}

export async function ensureStoreTable(): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS store (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    logger.info('Tabla store verificada en Supabase');
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'No se pudo crear/verificar la tabla store');
  }
}

// ---- Helpers de filas ----

export async function getRow<T>(key: string): Promise<T | null> {
  const p = getPool();
  if (!p) return null;
  try {
    const { rows } = await p.query('SELECT value FROM store WHERE key = $1', [key]);
    if (rows.length === 0) return null;
    return rows[0].value as T;
  } catch (error) {
    logger.error({ error: (error as Error).message, key }, 'store: getRow failed');
    return null;
  }
}

export async function setRow<T>(key: string, value: T): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO store (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  } catch (error) {
    logger.error({ error: (error as Error).message, key }, 'store: set failed');
    throw error;
  }
}

export async function deleteRow(key: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await p.query('DELETE FROM store WHERE key = $1', [key]);
  } catch (error) {
    logger.error({ error: (error as Error).message, key }, 'store: delete failed');
  }
}

// ---- Construcción de claves (compartidas con el script de migración) ----

export const storeKeys = {
  collection: (name: string) => name,
  syncMeta: 'sync-meta' as const,
  autoRefresh: 'auto:cfg' as const,
  home: 'home:cineby' as const,
  gnulahdHome: 'home:gnulahd' as const,
  user: (uid: string) => `user:${uid}`,
  favorites: (uid: string, profileId: string) => `fav:${uid}:${profileId}`,
  continueWatching: (uid: string, profileId: string) => `watch:${uid}:${profileId}`,
  history: (uid: string, profileId: string) => `hist:${uid}:${profileId}`,
  recommendations: (profileId: string) => `rec:${profileId}`,
};