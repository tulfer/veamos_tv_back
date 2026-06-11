export type SyncType =
  | 'movies'
  | 'series'
  | 'channels'
  | 'popularMovies'
  | 'popularSeries'
  | 'estrenoMovies'
  | 'estrenoSeries'
  | 'home';

export interface SyncJobStatus {
  status: 'idle' | 'running' | 'completed' | 'failed';
  lastRun: number | null;
  duration?: number;
  count?: number;
  error?: string;
}

export type SyncState = Record<SyncType, SyncJobStatus>;

const defaultStatus: SyncJobStatus = { status: 'idle', lastRun: null };

const state: SyncState = {
  movies: { ...defaultStatus },
  series: { ...defaultStatus },
  channels: { ...defaultStatus },
  popularMovies: { ...defaultStatus },
  popularSeries: { ...defaultStatus },
  estrenoMovies: { ...defaultStatus },
  estrenoSeries: { ...defaultStatus },
  home: { ...defaultStatus },
};

export function startSync(type: SyncType): boolean {
  if (state[type].status === 'running') return false;
  state[type] = { status: 'running', lastRun: Date.now(), duration: undefined, count: undefined, error: undefined };
  return true;
}

export function completeSync(type: SyncType, count?: number): void {
  const entry = state[type];
  const started = entry.lastRun;
  state[type] = {
    status: 'completed',
    lastRun: Date.now(),
    duration: started ? Date.now() - started : undefined,
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
