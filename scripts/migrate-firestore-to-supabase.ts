/* eslint-disable no-console */
/**
 * Migración one-shot: Firestore -> Supabase (tabla `store`).
 *
 * Lee los datos actuales de Firestore (todavía activo) y los vuelca en la
 * tabla JSONB `store` de Supabase usando las mismas claves del runtime
 * (src/services/store.ts).
 *
 * Requisitos:
 *   - DATABASE_URL: cadena de conexión Postgres/Supabase de destino.
 *   - Credenciales de Firebase admin (una de las siguientes):
 *       A) GOOGLE_APPLICATION_CREDENTIALS=ruta/al/service-account.json
 *       B) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *
 * Uso:
 *   $env:DATABASE_URL="postgres://postgres:pass@86.48.23.214:5432/postgres"
 *   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\secrets\firebase-sa.json"
 *   npx tsx scripts/migrate-firestore-to-supabase.ts
 *
 * Notas:
 *   - Es idempotente: cada destino se escribe con upsert.
 *   - Si el destino es el mismo de producción, migra en caliente sin parar el server.
 */

import admin from 'firebase-admin';
import { ensureStoreTable, setRow, storeKeys } from '../src/services/store';

function initFirebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'veamos-tv';
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId,
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    return;
  }
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    console.error('Falta GOOGLE_APPLICATION_CREDENTIALS o FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY');
    process.exit(1);
  }
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

/** Timestamp de Firestore -> ISO. Limpia undefined (pg no serializa undefined). */
function sanitize<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString() as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v)) as unknown as T;
  }
  const obj = value as Record<string, unknown>;
  if (obj._seconds !== undefined && obj._nanoseconds !== undefined) {
    return new Date(Number(obj._seconds) * 1000).toISOString() as unknown as T;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) cleaned[k] = sanitize(v);
  }
  return cleaned as unknown as T;
}

const COLLECTIONS: { name: string; key: string }[] = [
  { name: 'movies', key: 'movies' },
  { name: 'series', key: 'series' },
  { name: 'channels', key: 'channels' },
  { name: 'popular-movies', key: 'popular-movies' },
  { name: 'popular-series', key: 'popular-series' },
  { name: 'estreno-movies', key: 'estreno-movies' },
  { name: 'estreno-series', key: 'estreno-series' },
];

async function main() {
  initFirebase();

  if (!process.env.DATABASE_URL) {
    console.error('[migración] Falta DATABASE_URL (destino Supabase).');
    process.exit(1);
  }
  await ensureStoreTable();

  const db = admin.firestore();
  const start = Date.now();
  let writes = 0;

  for (const { name, key } of COLLECTIONS) {
    const snap = await db.collection(name).get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    await setRow(storeKeys.collection(key), sanitize(items));
    writes++;
    console.log(`├─ ${key}: ${items.length} items`);
  }

  const metaSnap = await db.collection('sync-meta').doc('data').get();
  if (metaSnap.exists) {
    await setRow(storeKeys.syncMeta, sanitize(metaSnap.data()));
    writes++;
  }

  const homeSnap = await db.collection('home-data').doc('cineby').get();
  if (homeSnap.exists) {
    await setRow(storeKeys.home, sanitize(homeSnap.data()));
    writes++;
    console.log('├─ home:cineby: ok');
  }

  const autoSnap = await db.doc('autoRefresh/config').get();
  if (autoSnap.exists) {
    await setRow(storeKeys.autoRefresh, sanitize(autoSnap.data()));
    writes++;
  }

  const usersSnap = await db.collection('users').get();
  console.log(`├─ users: ${usersSnap.size}`);
  for (const u of usersSnap.docs) {
    const uid = u.id;
    await setRow(storeKeys.user(uid), sanitize(u.data()));
    writes++;

    const subs: { coll: string; makeKey: (pid: string) => string }[] = [
      { coll: 'favorites', key: (pid) => storeKeys.favorites(uid, pid) },
      { coll: 'continue-watching', key: (pid) => storeKeys.continueWatching(uid, pid) },
      { coll: 'history', key: (pid) => storeKeys.history(uid, pid) },
    ];
    for (const { coll, key } of subs) {
      const subSnap = await u.ref.collection(coll).get();
      for (const p of subSnap.docs) {
        await setRow(key(p.id), sanitize({ items: (p.data() || {}).items || [] }));
        writes++;
      }
    }
  }

  const recSnap = await db.collection('recommendations').get();
  for (const r of recSnap.docs) {
    await setRow(storeKeys.recommendations(r.id), sanitize({ items: (r.data() || {}).items || [] }));
    writes++;
  }

  console.log(`✔ Migración completada en ${((Date.now() - start) / 1000).toFixed(1)}s (${writes} filas).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[migración] Error:', err?.message || err);
  process.exit(1);
});