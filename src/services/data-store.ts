import { getFirestore } from '../config/firebase';
import { logger } from '../utils/logger';
import { SyncData } from '../types';

const SYNC_COLLECTION = 'syncData';

function db() {
  return getFirestore();
}

async function getDoc<T>(docId: string): Promise<T | null> {
  try {
    const snap = await db().collection(SYNC_COLLECTION).doc(docId).get();
    return snap.exists ? (snap.data() as T) : null;
  } catch {
    return null;
  }
}

async function setDoc(docId: string, data: unknown): Promise<void> {
  await db().collection(SYNC_COLLECTION).doc(docId).set(data);
}

export async function loadSyncData(): Promise<SyncData | null> {
  try {
    const [moviesDoc, seriesDoc, channelsDoc, popularMoviesDoc, popularSeriesDoc, estrenoMoviesDoc, estrenoSeriesDoc, metadataDoc] = await Promise.all([
      getDoc<{ items: SyncData['movies'] }>('movies'),
      getDoc<{ items: SyncData['series'] }>('series'),
      getDoc<{ items: SyncData['channels'] }>('channels'),
      getDoc<{ items: SyncData['popularMovies'] }>('popularMovies'),
      getDoc<{ items: SyncData['popularSeries'] }>('popularSeries'),
      getDoc<{ items: SyncData['estrenoMovies'] }>('estrenoMovies'),
      getDoc<{ items: SyncData['estrenoSeries'] }>('estrenoSeries'),
      getDoc<{ updatedAt: number }>('_metadata'),
    ]);

    if (!metadataDoc) return null;

    return {
      movies: moviesDoc?.items || [],
      series: seriesDoc?.items || [],
      channels: channelsDoc?.items || [],
      popularMovies: popularMoviesDoc?.items || [],
      popularSeries: popularSeriesDoc?.items || [],
      estrenoMovies: estrenoMoviesDoc?.items || [],
      estrenoSeries: estrenoSeriesDoc?.items || [],
      updatedAt: metadataDoc.updatedAt || 0,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to load sync data from Firestore');
    return null;
  }
}

export async function saveSyncData(data: SyncData): Promise<void> {
  try {
    await Promise.all([
      setDoc('movies', { items: data.movies }),
      setDoc('series', { items: data.series }),
      setDoc('channels', { items: data.channels }),
      setDoc('popularMovies', { items: data.popularMovies }),
      setDoc('popularSeries', { items: data.popularSeries }),
      setDoc('estrenoMovies', { items: data.estrenoMovies }),
      setDoc('estrenoSeries', { items: data.estrenoSeries }),
      setDoc('_metadata', { updatedAt: data.updatedAt }),
    ]);
    logger.info({
      movies: data.movies.length,
      series: data.series.length,
      channels: data.channels.length,
    }, 'Sync data saved to Firestore');
  } catch (error) {
    logger.error({ error }, 'Failed to save sync data to Firestore');
    throw error;
  }
}

export async function getSyncStats(): Promise<{ movies: number; series: number; channels: number; updatedAt: number | null } | null> {
  try {
    const metadataDoc = await getDoc<{ updatedAt: number }>('_metadata');
    if (!metadataDoc) return null;

    const [moviesDoc, seriesDoc, channelsDoc] = await Promise.all([
      getDoc<{ items: unknown[] }>('movies'),
      getDoc<{ items: unknown[] }>('series'),
      getDoc<{ items: unknown[] }>('channels'),
    ]);

    return {
      movies: moviesDoc?.items?.length || 0,
      series: seriesDoc?.items?.length || 0,
      channels: channelsDoc?.items?.length || 0,
      updatedAt: metadataDoc.updatedAt || null,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get sync stats from Firestore');
    return null;
  }
}
