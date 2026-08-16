/* eslint-disable no-console */
/**
 * Restaura las colecciones de producción (Supabase, tabla `store`) desde el
 * backup JSON local `data/sync-data.json` (y sus splits `data/sync-data.json.<col>.json`).
 *
 * Requisitos:
 *   - DATABASE_URL: cadena de conexión Postgres/Supabase de producción.
 *
 * Uso:
 *   $env:DATABASE_URL="postgres://postgres:pass@host:5432/postgres"
 *   npx tsx scripts/restore-from-backup.ts                 # omite colecciones ya pobladas
 *   npx tsx scripts/restore-from-backup.ts --only=channels # solo canales
 *   npx tsx scripts/restore-from-backup.ts --force         # reemplaza todo
 *   npx tsx scripts/restore-from-backup.ts --dry-run
 *
 * Idempotente: cada colección se escribe con upsert por clave.
 */

import fs from 'fs';
import path from 'path';
import { ensureStoreTable, getRow, setRow, storeKeys } from '../src/services/store';

const FIELDS: { key: string; field: string; file: string | null }[] = [
  { key: 'movies', field: 'movies', file: 'sync-data.json.movies.json' },
  { key: 'series', field: 'series', file: 'sync-data.json.series.json' },
  { key: 'channels', field: 'channels', file: 'sync-data.json.channels.json' },
  { key: 'popular-movies', field: 'popularMovies', file: null },
  { key: 'popular-series', field: 'popularSeries', file: null },
  { key: 'estreno-movies', field: 'estrenoMovies', file: null },
  { key: 'estreno-series', field: 'estrenoSeries', file: null },
];

function loadJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[restore] Falta DATABASE_URL (Supabase destino).');
    process.exit(1);
  }
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
  const fields = only ? FIELDS.filter((f) => only.includes(f.key)) : FIELDS;
  await ensureStoreTable();

  const mainPath = path.resolve(process.cwd(), 'data', 'sync-data.json');
  if (!fs.existsSync(mainPath)) {
    console.error('[restore] No existe data/sync-data.json');
    process.exit(1);
  }
  const main = loadJson(mainPath) as Record<string, unknown>;
  let total = 0;
  let skipped = 0;

  for (const { key, field, file } of fields) {
    let items: unknown[] = Array.isArray(main[field]) ? (main[field] as unknown[]) : [];
    if (items.length === 0 && file) {
      const splitPath = path.resolve(process.cwd(), 'data', file);
      if (fs.existsSync(splitPath)) {
        const arr = loadJson(splitPath);
        if (Array.isArray(arr)) items = arr;
      }
    }

    if (!force) {
      const existing = await getRow<unknown[]>(storeKeys.collection(key));
      if (Array.isArray(existing) && existing.length > 0) {
        console.log(`├─ ${key}: ya tiene ${existing.length} items en la BD (se omite; usa --force para reemplazar)`);
        skipped++;
        continue;
      }
    }

    if (dryRun) {
      console.log(`├─ ${key}: ${items.length} items (dry-run, no se escribe)`);
      total += items.length;
      continue;
    }

    await setRow(storeKeys.collection(key), items);
    total += items.length;
    console.log(`├─ ${key}: ${items.length} items escritos`);
  }

  if (dryRun) {
    console.log(`✔ Total ${total} items (${skipped} omitidas). Quita --dry-run para escribir.`);
    process.exit(0);
  }
  console.log(`✔ Restauración completada: ${total} items escritos (${skipped} omitidas).`);
  console.log('   Después: corre un refresh ("TV en Vivo" / refresh-all / auto-refresh) para renovar las URLs expiradas.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[restore] Error:', err?.message || err);
  process.exit(1);
});