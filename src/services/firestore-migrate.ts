import { logger } from '../utils/logger';
import { env } from '../config/env';
import { ensureStoreTable, setRow, storeKeys, storeEnabled } from './store';
import type firebase from 'firebase-admin';

/**
 * Migración Firestore -> Supabase ejecutable desde el dashboard
 * (POST /sync/migrate-firestore-to-supabase).
 *
 * Lee los datos de Firestore (todavía activo) y los vuelca en la tabla JSONB
 * `store` de Supabase usando las mismas claves del runtime. Es idempotente.
 *
 * Requiere que el servidor tenga configurada una credencial de Firebase admin:
 *   - GOOGLE_APPLICATION_CREDENTIALS (env var de Node) o
 *   - FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (+ FIREBASE_PROJECT_ID)
 * Y DATABASE_URL apuntando a Supabase.
 */

export interface FirestoreMigrationStatus {
  running: boolean;
  progress: string;
  message: string;
  error: string | null;
  stats: {
    movies: number;
    series: number;
    channels: number;
    popularMovies: number;
    popularSeries: number;
    estrenoMovies: number;
    estrenoSeries: number;
    rows: number;
  };
  updatedAt: number;
}

export const firestoreMigrationStatus: FirestoreMigrationStatus = {
  running: false,
  progress: 'idle',
  message: '',
  error: null,
  stats: {
    movies: 0,
    series: 0,
    channels: 0,
    popularMovies: 0,
    popularSeries: 0,
    estrenoMovies: 0,
    estrenoSeries: 0,
    rows: 0,
  },
  updatedAt: 0,
};

export function getFirestoreMigrationStatus(): FirestoreMigrationStatus {
  return firestoreMigrationStatus;
}

function setStatus(progress: string, message: string): void {
  firestoreMigrationStatus.progress = progress;
  firestoreMigrationStatus.message = message;
  firestoreMigrationStatus.updatedAt = Date.now();
}

function updateMessage(message: string): void {
  firestoreMigrationStatus.message = message;
  firestoreMigrationStatus.updatedAt = Date.now();
}

/** Timestamp de Firestore -> ISO. Limpia undefined (pg no serializa undefined). */
function sanitize<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString() as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v)) as unknown as T;
  }
  const record = value as Record<string, unknown>;
  if (record['_seconds'] !== undefined && record['_nanoseconds'] !== undefined) {
    return new Date(Number(record['_seconds']) * 1000).toISOString() as unknown as T;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v !== undefined) cleaned[k] = sanitize(v);
  }
  return cleaned as unknown as T;
}

async function initFirebase(): Promise<typeof firebase> {
  const firebaseMod = (await import('firebase-admin')) as typeof firebase;
  if (firebaseMod.apps.length > 0) return firebaseMod;

  const projectId = env.FIREBASE_PROJECT_ID || 'veamos-tv';
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    firebaseMod.initializeApp({
      credential: firebaseMod.credential.applicationDefault(),
      projectId,
      databaseURL: env.FIREBASE_DATABASE_URL,
    });
    return firebaseMod;
  }

  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    throw new Error(
      'Falta una credencial de Firebase admin (GOOGLE_APPLICATION_CREDENTIALS o FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY).',
    );
  }
  firebaseMod.initializeApp({
    credential: firebaseMod.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    }),
    databaseURL: env.FIREBASE_DATABASE_URL,
  });
  return firebaseMod;
}

export async function runFirestoreToSupabase(): Promise<void> {
  if (!storeEnabled()) {
    throw new Error('DATABASE_URL no configurado (destino Supabase).');
  }

  await ensureStoreTable();

  const firebaseMod = await initFirebase();
  const db = firebaseMod.firestore();
  const stats = firestoreMigrationStatus.stats;
  stats.movies = 0;
  stats.series = 0;
  stats.channels = 0;
  stats.popularMovies = 0;
  stats.popularSeries = 0;
  stats.estrenoMovies = 0;
  stats.estrenoSeries = 0;
  stats.rows = 0;

  const writeRow = async (key: string, value: unknown): Promise<void> => {
    await setRow(key, sanitize(value));
    stats.rows++;
  };

  const collections: { name: string; key: string; label: string; stat: keyof typeof stats }[] = [
    { name: 'movies', key: storeKeys.collection('movies'), label: 'Películas', stat: 'movies' },
    { name: 'series', key: storeKeys.collection('series'), label: 'Series', stat: 'series' },
    { name: 'channels', key: storeKeys.collection('channels'), label: 'Canales', stat: 'channels' },
    { name: 'popular-movies', key: storeKeys.collection('popular-movies'), label: 'Populares (M)', stat: 'popularMovies' },
    { name: 'popular-series', key: storeKeys.collection('popular-series'), label: 'Populares (S)', stat: 'popularSeries' },
    { name: 'estreno-movies', key: storeKeys.collection('estreno-movies'), label: 'Estrenos (M)', stat: 'estrenoMovies' },
    { name: 'estreno-series', key: storeKeys.collection('estreno-series'), label: 'Estrenos (S)', stat: 'estrenoSeries' },
  ];

  for (const { name, key, label, stat } of collections) {
    setStatus('reading', `Leyendo ${label} de Firestore...`);
    const snap = await db.collection(name).get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    await writeRow(key, items);
    stats[stat] = items.length;
    updateMessage(`✔ ${label}: ${items.length} items`);
  }

  updateMessage('Leyendo sync-meta...');
  const metaSnap = await db.collection('sync-meta').doc('data').get();
  if (metaSnap.exists) {
    await writeRow(storeKeys.syncMeta, metaSnap.data());
    updateMessage('✔ sync-meta: ok');
  }

  updateMessage('Leyendo home (cineby)...');
  const homeSnap = await db.collection('home-data').doc('cineby').get();
  if (homeSnap.exists) {
    await writeRow(storeKeys.home, homeSnap.data());
    updateMessage('✔ home:cineby: ok');
  }

  updateMessage('Leyendo auto-refresh...');
  const autoSnap = await db.doc('autoRefresh/config').get();
  if (autoSnap.exists) {
    await writeRow(storeKeys.autoRefresh, autoSnap.data());
    updateMessage('✔ auto:cfg: ok');
  }

  const usersSnap = await db.collection('users').get();
  updateMessage(`Migrando usuarios (${usersSnap.size})...`);
  for (const u of usersSnap.docs) {
    await writeRow(storeKeys.user(u.id), u.data());

    const subs: { coll: string; key: (profileId: string) => string }[] = [
      { coll: 'favorites', key: (profileId) => storeKeys.favorites(u.id, profileId) },
      { coll: 'continue-watching', key: (profileId) => storeKeys.continueWatching(u.id, profileId) },
      { coll: 'history', key: (profileId) => storeKeys.history(u.id, profileId) },
    ];
    for (const { coll, key } of subs) {
      const subSnap = await u.ref.collection(coll).get();
      for (const p of subSnap.docs) {
        await writeRow(key(p.id), { items: (p.data() || {}).items || [] });
      }
    }
  }

  updateMessage('Leyendo recomendaciones...');
  const recSnap = await db.collection('recommendations').get();
  for (const r of recSnap.docs) {
    await writeRow(storeKeys.recommendations(r.id), { items: (r.data() || {}).items || [] });
  }

  setStatus('completed', `✔ Migración completada (${stats.rows} filas escritas)`);
  logger.info({ stats }, 'Firestore -> Supabase migration completed');
}