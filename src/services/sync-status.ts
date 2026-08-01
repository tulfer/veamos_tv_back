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
  | 'migrate';

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
}

export function getLogs(type: string): string[] {
  return logs[type] || [];
}

export function clearLogs(type: string): void {
  delete logs[type];
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
  migrate: { ...defaultStatus },
};

export function startSync(type: SyncType): boolean {
  if (state[type].status === 'running') return false;
  state[type] = { status: 'running', lastRun: Date.now(), duration: undefined, count: undefined, error: undefined, progress: undefined };
  return true;
}

export function updateSyncProgress(type: SyncType, current: number, message: string, total?: number): void {
  if (state[type].status === 'running') {
    state[type].progress = { current, total, message };
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
}

export function getSyncStatus(): SyncState {
  return { ...state };
}
