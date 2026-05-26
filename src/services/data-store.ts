import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { SyncData } from '../types';

const DEFAULT_PATH = path.resolve(process.cwd(), 'data', 'sync-data.json');

let dataPath = DEFAULT_PATH;

export function setDataPath(p: string): void {
  dataPath = path.resolve(p);
}

export function getDataPath(): string {
  return dataPath;
}

export function loadSyncData(): SyncData | null {
  try {
    if (!fs.existsSync(dataPath)) return null;
    const raw = fs.readFileSync(dataPath, 'utf-8');
    const data = JSON.parse(raw) as SyncData;
    if (!Array.isArray(data.channels)) data.channels = [];
    if (!Array.isArray(data.popularMovies)) data.popularMovies = [];
    if (!Array.isArray(data.popularSeries)) data.popularSeries = [];
    return data;
  } catch (error) {
    logger.error({ error }, 'Failed to load sync data');
    return null;
  }
}

export function saveSyncData(data: SyncData): void {
  try {
    const dir = path.dirname(dataPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (data.movies.length > 0) {
      fs.writeFileSync(dataPath + '.movies.json', JSON.stringify(data.movies, null, 2), 'utf-8');
    }
    if (data.series.length > 0) {
      fs.writeFileSync(dataPath + '.series.json', JSON.stringify(data.series, null, 2), 'utf-8');
    }
    if (data.channels.length > 0) {
      fs.writeFileSync(dataPath + '.channels.json', JSON.stringify(data.channels, null, 2), 'utf-8');
    }
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf-8');
    logger.info({ path: dataPath, movies: data.movies.length, series: data.series.length, channels: data.channels.length }, 'Sync data saved');
  } catch (error) {
    logger.error({ error }, 'Failed to save sync data');
  }
}

export function getSyncStats(): { movies: number; series: number; channels: number; updatedAt: number | null } | null {
  const data = loadSyncData();
  if (!data) return null;
  return { movies: data.movies.length, series: data.series.length, channels: data.channels.length, updatedAt: data.updatedAt };
}
