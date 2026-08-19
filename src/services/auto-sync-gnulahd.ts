import { getGnulahdAutoSyncConfig, setGnulahdAutoSyncLastRun, GNULAHD_AUTO_TASKS, GnulahdAutoTask } from './data-store';
import { tryAcquireLock } from './store';
import { runGnulahdHomeSync, runGnulahdKindSync } from '../modules/sync/controller';
import { logger } from '../utils/logger';

/**
 * Programador de sincronización automática de GNULA (home / movies / series / anime).
 *
 * Cada TICK_MS evalúa la configuración guardada ('gnulahd:auto:cfg'):
 * para cada tarea habilitada con intervalo en horas, si el tiempo desde su
 * última ejecución ya pasó, dispara el sync correspondiente en segundo plano.
 *
 * El lock atómico en la tabla `store` evita que varias instancias
 * (Cloud Run escala) sincronicen la misma tarea a la vez.
 */

const TICK_MS = 60_000;

const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

let timer: ReturnType<typeof setInterval> | null = null;

function parsePages(pages?: string): number[] {
  if (!pages || !pages.trim()) return [];
  const result = new Set<number>();
  for (const raw of pages.split(',')) {
    const part = raw.trim();
    if (/^\d+$/.test(part)) {
      result.add(parseInt(part, 10));
    } else if (/^(\d+)-(\d+)$/.test(part)) {
      const [, a, b] = part.match(/^(\d+)-(\d+)$/) as unknown as [string, string, string];
      const from = Math.min(parseInt(a, 10), parseInt(b, 10));
      const to = Math.max(parseInt(a, 10), parseInt(b, 10));
      for (let p = from; p <= to; p++) result.add(p);
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

async function runDueSync(task: string): Promise<void> {
  const kind = task === 'movies' ? 'peliculas' : task === 'series' ? 'series' : task === 'anime' ? 'anime' : null;
  try {
    if (task === 'home') {
      await runGnulahdHomeSync();
    } else if (kind) {
      const config = await getGnulahdAutoSyncConfig();
      const taskCfg = config.tasks[task as GnulahdAutoTask];
      const pages = parsePages(taskCfg?.pages);
      // El auto-sync usa los mismos parámetros guardados en la tarjeta
      // (páginas y "reemplazar contenido").
      const replace = taskCfg?.replace === true;
      await runGnulahdKindSync(kind as 'peliculas' | 'series' | 'anime', pages.length > 0 ? pages : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], replace);
    }
  } catch (error) {
    logger.error({ error: (error as Error).message, task }, 'gnulahd auto-sync: falló la ejecución');
  }
}

async function tick(): Promise<void> {
  let config;
  try {
    config = await getGnulahdAutoSyncConfig();
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'gnulahd auto-sync: no se pudo leer la configuración');
    return;
  }

  const now = Date.now();

  for (const task of GNULAHD_AUTO_TASKS) {
    const taskCfg = config.tasks[task];
    if (!taskCfg?.enabled) continue;

    const intervalMs = taskCfg.intervalHours * 3_600_000;
    if (taskCfg.lastRunAt != null && now - taskCfg.lastRunAt < intervalMs) continue;

    const lockKey = `gnulahd:auto:lock:${task}`;
    const lockTtlMs = Math.max(intervalMs, 30 * 60_000);
    const acquired = await tryAcquireLock(lockKey, INSTANCE_ID, lockTtlMs);
    if (!acquired) {
      logger.info({ task }, 'gnulahd auto-sync: otra instancia ya sincronizó esta tarea, omitiendo');
      continue;
    }
    try {
      await setGnulahdAutoSyncLastRun(task, now);
    } catch (error) {
      logger.error({ error: (error as Error).message, task }, 'gnulahd auto-sync: no se pudo registrar la ejecución');
      continue;
    }
    logger.info({ task, intervalHours: taskCfg.intervalHours }, 'gnulahd auto-sync: sincronización automática iniciada');
    void runDueSync(task);
  }
}

export function startGnulahdAutoSyncScheduler(): void {
  if (timer) return;
  logger.info(`gnulahd auto-sync: programador iniciado (evaluación cada ${TICK_MS / 1000}s)`);
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  void tick();
}

export function stopGnulahdAutoSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}