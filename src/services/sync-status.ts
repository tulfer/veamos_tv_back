import { getRow, setRow, storeKeys } from './store';
import { logger } from '../utils/logger';

export type SyncType =
  | 'movies'
  | 'series'
  | 'all'
  | 'channels'
  | 'popularMovies'
  | 'popularSeries'
  | 'estrenoMovies'
  | 'estrenoSeries'
  | 'home'
  | 'fetchDetails'
  | 'importM3U'
  | 'refreshAll'
  | 'refreshExpired'
  | 'refreshOne'
  | 'refreshProvider'
  | 'migrate'
  | 'gnulahdHome'
  | 'gnulahdMovies'
  | 'gnulahdSeries'
  | 'gnulahdAnime';

export interface SyncProgress {
  current: number;
  total?: number;
  message: string;
}

export interface SyncJobStatus {
  status: 'idle' | 'running' | 'completed' | 'failed';
  lastRun: number | null;
  duration?: number;
  count?: number;
  error?: string;
  progress?: SyncProgress;
}

export type SyncState = Record<SyncType, SyncJobStatus>;

const defaultStatus: SyncJobStatus = { status: 'idle', lastRun: null };

// Logs detallados por tipo de sincronización
const logs: Record<string, string[]> = {};
const LOG_MAX = 500;
type SyncEvent =
  | { type: 'status'; status: SyncState }
  | { type: 'log'; syncType: string; message: string };
const eventListeners = new Set<(event: SyncEvent) => void>();

function emitSyncEvent(event: SyncEvent): void {
  for (const listener of eventListeners) {
    try { listener(event); } catch (error) { logger.warn({ error }, 'sync-status: listener failed'); }
  }
}

export function subscribeSyncEvents(listener: (event: SyncEvent) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

// ── Persistencia en Supabase (store): el estado y los logs sobreviven
//    refrescos de página y reinicios del proceso. ──
const LOG_PERSIST_DELAY_MS = 2000;
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

async function persistStateRow(): Promise<void> {
  try {
    await setRow(storeKeys.syncStatus, state);
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'sync-status: no se pudo persistir el estado');
  }
}

function scheduleLogsPersist(): void {
  if (logFlushTimer) clearTimeout(logFlushTimer);
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    void setRow(storeKeys.syncLogs, { logs, updatedAt: Date.now() }).catch((error: Error) => {
      logger.error({ error: error?.message }, 'sync-status: no se pudieron persistir los logs');
    });
  }, LOG_PERSIST_DELAY_MS);
}

/**
 * Restaura el estado y los logs persistidos al arrancar el servidor.
 * Solo se restauran estados terminales (completed/failed): un 'running'
 * guardado proviene de un proceso que murió a mitad de ejecución.
 */
export async function hydrateSyncState(): Promise<void> {
  try {
    const [statusRow, logsRow] = await Promise.all([
      getRow<Partial<Record<SyncType, Partial<SyncJobStatus>>>>(storeKeys.syncStatus),
      getRow<{ logs?: Record<string, string[]> }>(storeKeys.syncLogs),
    ]);

    if (statusRow) {
      for (const [key, value] of Object.entries(statusRow)) {
        if (!(key in state) || !value) continue;
        if (value.status !== 'completed' && value.status !== 'failed') continue;
        state[key as SyncType] = {
          status: value.status,
          lastRun: typeof value.lastRun === 'number' ? value.lastRun : null,
          duration: typeof value.duration === 'number' ? value.duration : undefined,
          count: typeof value.count === 'number' ? value.count : undefined,
          error: typeof value.error === 'string' ? value.error : undefined,
        };
      }
    }

    if (logsRow?.logs && typeof logsRow.logs === 'object') {
      for (const [type, lines] of Object.entries(logsRow.logs)) {
        if (Array.isArray(lines) && lines.length > 0) {
          logs[type] = lines.slice(-LOG_MAX);
        }
      }
    }

    logger.info('sync-status: estado y logs restaurados desde la BD');
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'sync-status: falló la restauración de estado/logs');
  }
}

function logTimestamp(): string {
  const tz = process.env.LOG_TIMEZONE || 'America/Bogota';
  try {
    return new Date().toLocaleTimeString('en-US', { timeZone: tz, hour12: false });
  } catch {
    return new Date().toLocaleTimeString();
  }
}

export function pushLog(type: string, message: string): void {
  if (!logs[type]) logs[type] = [];
  logs[type].push(`[${logTimestamp()}] ${message}`);
  if (logs[type].length > LOG_MAX) logs[type].splice(0, logs[type].length - LOG_MAX);
  emitSyncEvent({ type: 'log', syncType: type, message: logs[type][logs[type].length - 1] });
  scheduleLogsPersist();
}

export function getLogs(type: string): string[] {
  return logs[type] || [];
}

export function clearLogs(type: string): void {
  delete logs[type];
  scheduleLogsPersist();
}

const state: SyncState = {
  movies: { ...defaultStatus },
  series: { ...defaultStatus },
  all: { ...defaultStatus },
  channels: { ...defaultStatus },
  popularMovies: { ...defaultStatus },
  popularSeries: { ...defaultStatus },
  estrenoMovies: { ...defaultStatus },
  estrenoSeries: { ...defaultStatus },
  home: { ...defaultStatus },
  fetchDetails: { ...defaultStatus },
  importM3U: { ...defaultStatus },
  refreshAll: { ...defaultStatus },
  refreshExpired: { ...defaultStatus },
  refreshOne: { ...defaultStatus },
  refreshProvider: { ...defaultStatus },
  migrate: { ...defaultStatus },
  gnulahdHome: { ...defaultStatus },
  gnulahdMovies: { ...defaultStatus },
  gnulahdSeries: { ...defaultStatus },
  gnulahdAnime: { ...defaultStatus },
};

export function startSync(type: SyncType): boolean {
  if (state[type].status === 'running') return false;
  state[type] = { status: 'running', lastRun: Date.now(), duration: undefined, count: undefined, error: undefined, progress: undefined };
  emitSyncEvent({ type: 'status', status: getSyncStatus() });
  return true;
}

export function updateSyncProgress(type: SyncType, current: number, message: string, total?: number): void {
  if (state[type].status === 'running') {
    state[type].progress = { current, total, message };
    emitSyncEvent({ type: 'status', status: getSyncStatus() });
  }
}

export function completeSync(type: SyncType, count?: number): void {
  const entry = state[type];
  const started = entry.lastRun;
  state[type] = {
    status: 'completed',
    lastRun: Date.now(),
    duration: started ? Date.now() - started : undefined,
    progress: count !== undefined ? { current: count, message: count > 0 ? `${count} items procesados` : 'Completado sin datos' } : undefined,
    count,
  };
  emitSyncEvent({ type: 'status', status: getSyncStatus() });
  void persistStateRow();
}

export function failSync(type: SyncType, error: string): void {
  const entry = state[type];
  const started = entry.lastRun;
  state[type] = {
    status: 'failed',
    lastRun: Date.now(),
    duration: started ? Date.now() - started : undefined,
    error,
  };
  emitSyncEvent({ type: 'status', status: getSyncStatus() });
  void persistStateRow();
}

export function getSyncStatus(): SyncState {
  return { ...state };
}
