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
  state[type] = { status: 'running', lastRun: Date.now() };
  return true;
}

export function completeSync(type: SyncType): void {
  state[type] = { status: 'completed', lastRun: Date.now() };
}

export function failSync(type: SyncType, error: string): void {
  state[type] = { status: 'failed', lastRun: Date.now(), error };
}

export function getSyncStatus(): SyncState {
  return { ...state };
}
