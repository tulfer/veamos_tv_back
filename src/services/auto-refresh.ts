import { getAutoRefreshConfig, setAutoRefreshProviderLastRun, AutoRefreshConfig } from './data-store';
import { tryAcquireLock } from './store';
import { scheduleProviderRefresh } from '../modules/live-tv/controller';
import { logger } from '../utils/logger';

/**
 * Programador de refresco automático por proveedor.
 *
 * Cada TICK_MS evalúa la configuración guardada ('auto:cfg'):
 * para cada proveedor configurado con intervalo, si el tiempo desde su
 * última ejecución ya pasó, dispara refreshProviderChannels.
 *
 * El lock atómico en la tabla `store` evita que varias instancias
 * (Cloud Run escala) refresquen el mismo proveedor a la vez.
 */

const TICK_MS = 30_000;

const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

let timer: ReturnType<typeof setInterval> | null = null;

export interface DueEntry {
  provider: string;
  minutes: number;
  lastRun: number | null;
}

export function computeDueProviders(config: AutoRefreshConfig, now: number): DueEntry[] {
  if (!config.enabled) return [];
  const due: DueEntry[] = [];
  for (const [provider, minutes] of Object.entries(config.providers)) {
    const lastRun = config.providerLastRuns[provider] ?? config.lastRunAt ?? null;
    if (lastRun == null) {
      due.push({ provider, minutes, lastRun: null });
      continue;
    }
    if (now - lastRun >= minutes * 60_000) {
      due.push({ provider, minutes, lastRun });
    }
  }
  return due;
}

async function tick(): Promise<void> {
  let config: AutoRefreshConfig;
  try {
    config = await getAutoRefreshConfig();
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'auto-refresh: no se pudo leer la configuración');
    return;
  }

  const now = Date.now();
  const due = computeDueProviders(config, now);

  for (const entry of due) {
    const lockKey = `auto:lock:${entry.provider}`;
    const lockTtlMs = Math.max(entry.minutes * 60_000, 5 * 60_000);
    const acquired = await tryAcquireLock(lockKey, INSTANCE_ID, lockTtlMs);
    if (!acquired) {
      logger.info({ provider: entry.provider }, 'auto-refresh: otra instancia ya refrescó este proveedor, omitiendo');
      continue;
    }
    try {
      await setAutoRefreshProviderLastRun(entry.provider, now);
    } catch (error) {
      logger.error({ error: (error as Error).message, provider: entry.provider }, 'auto-refresh: no se pudo registrar la ejecución');
      continue;
    }
    logger.info({ provider: entry.provider, intervalMinutes: entry.minutes }, 'auto-refresh: refresco automático por proveedor iniciado');
    scheduleProviderRefresh(entry.provider as never);
  }
}

export function startAutoRefreshScheduler(): void {
  if (timer) return;
  logger.info(`auto-refresh: programador iniciado (evaluación cada ${TICK_MS / 1000}s)`);
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  void tick();
}

export function stopAutoRefreshScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
