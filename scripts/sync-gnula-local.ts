/* eslint-disable no-console */
/**
 * Sincroniza GNULA (home, películas, series y anime) desde LOCAL y guarda en la
 * base de producción (Supabase/Postgres). Útil mientras la IP del servidor
 * (dokploy) esté bloqueada/rate-limiteada por gnulahd: aquí el scrape corre desde
 * el entorno local donde GNULA responde y los datos se escriben en la misma BD
 * que lee dokploy.
 *
 * Requisitos:
 *   - DATABASE_URL: cadena de conexión Postgres/Supabase de PRODUCCIÓN.
 *     Puede ir en .env local o como variable de entorno.
 *
 * Uso:
 *   npx tsx scripts/sync-gnula-local.ts                  # todo: home + movies + series + anime
 *   npx tsx scripts/sync-gnula-local.ts --home           # solo home
 *   npx tsx scripts/sync-gnula-local.ts --movies         # solo películas
 *   npx tsx scripts/sync-gnula-local.ts --series         # solo series
 *   npx tsx scripts/sync-gnula-local.ts --anime          # solo anime
 *   npx tsx scripts/sync-gnula-local.ts --anime --pages=1-3
 *   npx tsx scripts/sync-gnula-local.ts --replace        # reemplaza (vacía y re-sincroniza)
 */

import { ensureStoreTable, storeEnabled } from '../src/services/store';
import { getSyncStatus } from '../src/services/sync-status';
import type { SyncType, SyncJobStatus } from '../src/services/sync-status';
import { runGnulahdHomeSync, runGnulahdKindSync, runAnimeSync } from '../src/modules/sync/controller';

function parsePages(value: string | undefined): number[] {
  if (!value?.trim()) return [];
  const result: number[] = [];
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      for (let i = start; i <= end; i++) result.push(i);
    } else if (/^\d+$/.test(trimmed)) {
      result.push(parseInt(trimmed, 10));
    }
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

const DEFAULT_PAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Espera a que el sync en segundo plano del controller termine (polling). */
async function waitForCompletion(type: SyncType, timeoutMs = 30 * 60 * 1000): Promise<SyncJobStatus> {
  const started = Date.now();
  for (;;) {
    const entry = getSyncStatus()[type];
    if (!entry || entry.status === 'idle') {
      // Aún no ha arrancado (puede tardar un tick en registrarse).
      if (Date.now() - started > 5000) {
        throw new Error(`El sync '${type}' no arrancó.`);
      }
      await sleep(1000);
      continue;
    }
    if (entry.status === 'completed' || entry.status === 'failed') {
      return entry;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timeout esperando a '${type}' (${timeoutMs / 1000}s).`);
    }
    // Muestra el progreso periódicamente.
    if (entry.progress?.message) {
      console.log(`   → ${entry.progress.message}`);
    }
    await sleep(5000);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const want = (name: string) => args.includes(name);
  const replace = want('--replace');
  const pagesArg = args.find((a) => a.startsWith('--pages='))?.split('=')[1];
  const hasPages = pagesArg !== undefined;
  const pages = parsePages(pagesArg);

  if (!storeEnabled()) {
    console.error('❌ DATABASE_URL no está configurada. Ponla en .env local o como variable de entorno.');
    console.error('   Ej: postgres://postgres:pass@host:5432/postgres');
    process.exit(1);
  }

  await ensureStoreTable();
  console.log('✅ Conectado a la base. Tabla store verificada.\n');

  const only = ['--home', '--movies', '--series', '--anime'].find((f) => want(f));
  interface Task { label: string; type: SyncType; run: () => Promise<boolean>; }
  const tasks: Task[] = [];

  if (!only || only === '--home') {
    tasks.push({ label: 'HOME', type: 'gnulahdHome', run: () => runGnulahdHomeSync() });
  }
  if (!only || only === '--movies') {
    tasks.push({
      label: 'PELICULAS', type: 'gnulahdMovies',
      run: () => runGnulahdKindSync('peliculas', hasPages ? pages : DEFAULT_PAGES, replace),
    });
  }
  if (!only || only === '--series') {
    tasks.push({
      label: 'SERIES', type: 'gnulahdSeries',
      run: () => runGnulahdKindSync('series', hasPages ? pages : DEFAULT_PAGES, replace),
    });
  }
  if (!only || only === '--anime') {
    tasks.push({
      label: 'ANIME', type: 'gnulahdAnime',
      run: () => runAnimeSync(hasPages ? pages : DEFAULT_PAGES, replace),
    });
  }

  let failed = 0;
  for (const task of tasks) {
    console.log(`\n========== Sincronizando ${task.label} ==========`);
    try {
      const started = await task.run();
      if (!started) {
        console.warn(`⚠️  ${task.label}: ya había una sincronización en curso, omitiendo...`);
        continue;
      }
      const result = await waitForCompletion(task.type);
      if (result.status === 'failed') {
        console.error(`❌ ${task.label}: falló → ${result.error || 'error desconocido'}`);
        failed++;
      } else {
        console.log(`✅ ${task.label}: completado${result.count !== undefined ? ` (${result.count} items)` : ''}.`);
      }
    } catch (error) {
      console.error(`❌ ${task.label}: `, (error as Error).message);
      failed++;
    }
  }

  console.log('\n========== Resumen ==========');
  if (failed) {
    console.error(`❌ ${failed} tarea(s) fallaron.`);
    process.exit(1);
  }
  console.log('✅ Sync local finalizado. Los datos quedaron escritos en la BD de producción.');
  process.exit(0);
}

main().catch((error) => {
  console.error('Sync local falló:', error);
  process.exit(1);
});
