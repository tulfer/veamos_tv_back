import fs from 'fs';
import path from 'path';
import { FastifyRequest, FastifyReply } from 'fastify';
import { scrapeMovies, scrapeMovieDetail, scrapePopularMovies } from '../../providers/movies';
import { scrapeSeries, scrapeSeriesDetail, scrapePopularSeries } from '../../providers/series';
import { saveSyncData, loadSyncData, saveHomeData, loadHomeData, getCollectionCounts, getCollectionCount, getAutoRefreshConfig, setAutoRefreshConfig } from '../../services/data-store';
import { fetchItemDetails } from '../../providers/cineby';
import { closeBrowser } from '../../services/video-resolver';
import { fetchLiveChannels, parseM3U, validateBatch } from '../../providers/live-tv';
import { fetchHTML } from '../../utils/http';
import { logger } from '../../utils/logger';
import { memoryCache } from '../../cache/memory';
import { SyncMovie, SyncSeries, SyncData, LiveChannel } from '../../types';
import { startSync, completeSync, failSync, updateSyncProgress, getLogs, clearLogs, SyncType, getSyncStatus } from '../../services/sync-status';
import { firestoreMigrationStatus, getFirestoreMigrationStatus, runFirestoreToSupabase, FirestoreMigrationStatus } from '../../services/firestore-migrate';
import { REFRESH_PROVIDERS } from '../live-tv/controller';
import { AutoRefreshConfig } from '../../services/data-store';

interface MigrationStatus {
  running: boolean;
  progress: string;
  message: string;
  error: string | null;
  stats: {
    movies: number; series: number; channels: number;
    popularMovies: number; popularSeries: number;
    estrenoMovies: number; estrenoSeries: number;
  };
  updatedAt: number;
}

const migrationStatus: MigrationStatus = {
  running: false,
  progress: 'idle',
  message: '',
  error: null,
  stats: { movies: 0, series: 0, channels: 0, popularMovies: 0, popularSeries: 0, estrenoMovies: 0, estrenoSeries: 0 },
  updatedAt: 0,
};

const CONCURRENCY = 5;

function mergeByIdGeneric<T extends { id: string }>(newItems: T[], existingItems: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of existingItems) {
    map.set(item.id, item);
  }
  for (const item of newItems) {
    map.set(item.id, item);
  }
  return Array.from(map.values());
}

function mergeChannels(newChannels: LiveChannel[], existingChannels: LiveChannel[]): LiveChannel[] {
  const map = new Map<string, LiveChannel>();
  for (const channel of existingChannels) {
    map.set(channel.id, channel);
  }
  for (const channel of newChannels) {
    map.set(channel.id, channel);
  }
  return Array.from(map.values());
}

function parsePages(pages?: string): number[] {
  if (!pages) return [];
  const result = new Set<number>();
  for (const raw of pages.split(',')) {
    const part = raw.trim();
    const range = part.split('-').map(Number);
    if (range.length === 2 && !isNaN(range[0]) && !isNaN(range[1])) {
      for (let p = range[0]; p <= range[1]; p++) result.add(p);
    } else {
      const n = Number(part);
      if (!isNaN(n)) result.add(n);
    }
  }
  return [...result].sort((a, b) => a - b);
}

async function processBatch<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(fn));
  }
}

async function syncMovies(pages: number[], type: SyncType = 'movies'): Promise<SyncMovie[]> {
  const allItems: { id: string; title: string; poster?: string; rating?: number; year?: number }[] = [];

  for (const page of pages) {
    const pageData = await scrapeMovies(page);
    for (const item of pageData.items) {
      allItems.push({ id: item.id, title: item.title, poster: item.poster, rating: item.rating, year: item.year });
    }
    updateSyncProgress(type, allItems.length, `Escaneando página ${page}...`);
    logger.info({ page, total: allItems.length }, 'Movies list page synced');
  }

  const results: SyncMovie[] = [];
  let processed = 0;

  await processBatch(allItems, async (item) => {
    try {
      const detail = await scrapeMovieDetail(item.id);
      processed++;
      updateSyncProgress(type, processed, `Procesando detalles (${processed}/${allItems.length})...`, allItems.length);
      if (detail) {
        results.push({
          id: detail.id,
          title: detail.title,
          poster: detail.poster || item.poster,
          backdrop: detail.backdrop || item.poster,
          rating: detail.rating,
          year: detail.year,
          description: detail.description,
          genres: detail.genres,
          cast: detail.cast,
          duration: detail.duration,
          videos: detail.videos,
        });
        return;
      }
    } catch { /* fallback below */ }

    results.push({
      id: item.id,
      title: item.title,
      poster: item.poster,
      rating: item.rating,
      year: item.year,
    });
  });

  updateSyncProgress(type, results.length, `${results.length} películas procesadas`);
  return results;
}

async function syncSeries(pages: number[], type: SyncType = 'series'): Promise<SyncSeries[]> {
  const allItems: { id: string; title: string; poster?: string; rating?: number; year?: number }[] = [];

  for (const page of pages) {
    const pageData = await scrapeSeries(page);
    for (const item of pageData.items) {
      allItems.push({ id: item.id, title: item.title, poster: item.poster, rating: item.rating, year: item.year });
    }
    updateSyncProgress(type, allItems.length, `Escaneando página ${page}...`);
    logger.info({ page, total: allItems.length }, 'Series list page synced');
  }

  const results: SyncSeries[] = [];
  let processed = 0;

  await processBatch(allItems, async (item) => {
    try {
      const detail = await scrapeSeriesDetail(item.id);
      processed++;
      updateSyncProgress(type, processed, `Procesando detalles (${processed}/${allItems.length})...`, allItems.length);
      if (detail) {
        results.push({
          id: detail.id,
          title: detail.title,
          poster: detail.poster || item.poster,
          backdrop: detail.backdrop || item.poster,
          rating: detail.rating,
          year: detail.year,
          description: detail.description,
          genres: detail.genres,
          cast: detail.cast,
          seasons: detail.seasons,
          videos: detail.videos,
        });
        return;
      }
    } catch { /* fallback below */ }

    results.push({
      id: item.id,
      title: item.title,
      poster: item.poster,
      rating: item.rating,
      year: item.year,
    });
  });

  updateSyncProgress(type, results.length, `${results.length} series procesadas`);
  return results;
}

async function runBackgroundSync(
  type: SyncType,
  fn: () => Promise<number | undefined>,
): Promise<void> {
  memoryCache.flush();
  try {
    const count = await fn();
    completeSync(type, count);
  } catch (error: any) {
    logger.error({ error, type }, `${type} sync failed`);
    failSync(type, error.message);
  }
}

export async function syncMoviesHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { pages?: string; replace?: boolean } | undefined;
  const pages = parsePages(body?.pages);
  if (pages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  if (!startSync('movies')) {
    return reply.send({ ok: true, message: 'Movies sync already in progress' });
  }

  reply.send({ ok: true, message: 'Movies sync started' });

  runBackgroundSync('movies', async () => {
    const movies = await syncMovies(pages);
    const existing = await loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalMovies = shouldReplace ? movies : mergeByIdGeneric(movies, existing?.movies || []);
    await saveSyncData({
      movies: finalMovies,
      series: existing?.series || [],
      channels: existing?.channels || [],
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    await closeBrowser();
    return finalMovies.length;
  });
}

export async function syncSeriesHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { pages?: string; replace?: boolean } | undefined;
  const pages = parsePages(body?.pages);
  if (pages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  if (!startSync('series')) {
    return reply.send({ ok: true, message: 'Series sync already in progress' });
  }

  reply.send({ ok: true, message: 'Series sync started' });

  runBackgroundSync('series', async () => {
    const series = await syncSeries(pages);
    const existing = await loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalSeries = shouldReplace ? series : mergeByIdGeneric(series, existing?.series || []);
    await saveSyncData({
      movies: existing?.movies || [],
      series: finalSeries,
      channels: existing?.channels || [],
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    await closeBrowser();
    return finalSeries.length;
  });
}

export async function syncAllHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { pages?: string; movies?: string; series?: string; replace?: boolean } | undefined;
  const moviePages = parsePages(body?.movies ?? body?.pages);
  const seriesPages = parsePages(body?.series ?? body?.pages);
  if (moviePages.length === 0 && seriesPages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  if (!startSync('movies') && moviePages.length > 0) {
    return reply.send({ ok: true, message: 'Movies sync already in progress' });
  }
  if (!startSync('series') && seriesPages.length > 0) {
    return reply.send({ ok: true, message: 'Series sync already in progress' });
  }

  reply.send({ ok: true, message: 'Full sync started' });

  if (moviePages.length > 0) {
    runBackgroundSync('movies', async () => {
      const movies = await syncMovies(moviePages);
      const existing = await loadSyncData();
      const shouldReplace = body?.replace === true;
      const finalMovies = shouldReplace ? movies : mergeByIdGeneric(movies, existing?.movies || []);
      await saveSyncData({
        movies: finalMovies,
        series: existing?.series || [],
        channels: existing?.channels || [],
        popularMovies: existing?.popularMovies || [],
        popularSeries: existing?.popularSeries || [],
        estrenoMovies: existing?.estrenoMovies || [],
        estrenoSeries: existing?.estrenoSeries || [],
        updatedAt: Date.now(),
      });
      await closeBrowser();
      return finalMovies.length;
    });
  }
  if (seriesPages.length > 0) {
    runBackgroundSync('series', async () => {
      const series = await syncSeries(seriesPages);
      const existing = await loadSyncData();
      const shouldReplace = body?.replace === true;
      const finalSeries = shouldReplace ? series : mergeByIdGeneric(series, existing?.series || []);
      await saveSyncData({
        movies: existing?.movies || [],
        series: finalSeries,
        channels: existing?.channels || [],
        popularMovies: existing?.popularMovies || [],
        popularSeries: existing?.popularSeries || [],
        estrenoMovies: existing?.estrenoMovies || [],
        estrenoSeries: existing?.estrenoSeries || [],
        updatedAt: Date.now(),
      });
      await closeBrowser();
      return finalSeries.length;
    });
  }
}

export async function syncEstrenoMoviesHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { pages?: string; replace?: boolean } | undefined;
  const pages = parsePages(body?.pages);
  if (pages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  if (!startSync('estrenoMovies')) {
    return reply.send({ ok: true, message: 'Estreno movies sync already in progress' });
  }

  reply.send({ ok: true, message: 'Estreno movies sync started' });

  runBackgroundSync('estrenoMovies', async () => {
    const movies = await syncMovies(pages, 'estrenoMovies');
    const existing = await loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalEstrenoMovies = shouldReplace ? movies : mergeByIdGeneric(movies, existing?.estrenoMovies || []);
    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: existing?.channels || [],
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: finalEstrenoMovies,
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    await closeBrowser();
    return finalEstrenoMovies.length;
  });
}

export async function syncEstrenoSeriesHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { pages?: string; replace?: boolean } | undefined;
  const pages = parsePages(body?.pages);
  if (pages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  if (!startSync('estrenoSeries')) {
    return reply.send({ ok: true, message: 'Estreno series sync already in progress' });
  }

  reply.send({ ok: true, message: 'Estreno series sync started' });

  runBackgroundSync('estrenoSeries', async () => {
    const series = await syncSeries(pages, 'estrenoSeries');
    const existing = await loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalEstrenoSeries = shouldReplace ? series : mergeByIdGeneric(series, existing?.estrenoSeries || []);
    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: existing?.channels || [],
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: finalEstrenoSeries,
      updatedAt: Date.now(),
    });
    await closeBrowser();
    return finalEstrenoSeries.length;
  });
}

async function migrateChannelsFromJson(): Promise<number> {
  const jsonPath = path.resolve(process.cwd(), 'data', 'sync-data.json');
  if (!fs.existsSync(jsonPath)) return 0;

  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const data = JSON.parse(raw);
    const channels: LiveChannel[] = data.channels || [];
    if (channels.length === 0) return 0;

    const existing = await loadSyncData();
    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels,
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    logger.info({ channels: channels.length }, 'Channels migrated from JSON to Firestore');
    return channels.length;
  } catch (error) {
    logger.error({ error }, 'Failed to migrate channels from JSON');
    return 0;
  }
}

export async function syncLiveHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { replace?: boolean } | undefined;

  // Check if sync already running or if JSON migration needed
  if (!startSync('channels')) {
    return reply.send({ ok: true, message: 'Channels sync already in progress' });
  }

  reply.send({ ok: true, message: 'Channels sync started' });

  runBackgroundSync('channels', async () => {
    const existing = await loadSyncData();

    if (!existing || existing.channels.length === 0) {
      updateSyncProgress('channels', 0, 'Migrando canales desde JSON...');
      const migrated = await migrateChannelsFromJson();
      if (migrated > 0) {
        updateSyncProgress('channels', migrated, `${migrated} canales migrados desde JSON`);
        logger.info({ migrated }, 'Channels migrated from JSON');
        return migrated;
      }
    }

    updateSyncProgress('channels', 0, 'Obteniendo canales desde iptv-org...');
    const channels = await fetchLiveChannels();
    updateSyncProgress('channels', channels.length, `${channels.length} canales obtenidos, guardando...`);
    const shouldReplace = body?.replace === true;
    const finalChannels = shouldReplace ? channels : mergeChannels(channels, existing?.channels || []);
    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: finalChannels,
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    updateSyncProgress('channels', finalChannels.length, `${finalChannels.length} canales guardados`);
    return finalChannels.length;
  });
}

export async function syncPopularMoviesHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { replace?: boolean } | undefined;
  if (!startSync('popularMovies')) {
    return reply.send({ ok: true, message: 'Popular movies sync already in progress' });
  }

  reply.send({ ok: true, message: 'Popular movies sync started' });

  runBackgroundSync('popularMovies', async () => {
    updateSyncProgress('popularMovies', 0, 'Scrapeando películas populares...');
    const popularMovies = await scrapePopularMovies();
    updateSyncProgress('popularMovies', popularMovies.length, `${popularMovies.length} películas obtenidas, guardando...`);
    const existing = await loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalPopularMovies = shouldReplace ? popularMovies : mergeByIdGeneric(popularMovies, existing?.popularMovies || []);
    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: existing?.channels || [],
      popularMovies: finalPopularMovies,
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    updateSyncProgress('popularMovies', finalPopularMovies.length, `${finalPopularMovies.length} películas populares guardadas`);
    return finalPopularMovies.length;
  });
}

export async function syncPopularSeriesHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { replace?: boolean } | undefined;
  if (!startSync('popularSeries')) {
    return reply.send({ ok: true, message: 'Popular series sync already in progress' });
  }

  reply.send({ ok: true, message: 'Popular series sync started' });

  runBackgroundSync('popularSeries', async () => {
    updateSyncProgress('popularSeries', 0, 'Scrapeando series populares...');
    const popularSeries = await scrapePopularSeries();
    updateSyncProgress('popularSeries', popularSeries.length, `${popularSeries.length} series obtenidas, guardando...`);
    const existing = await loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalPopularSeries = shouldReplace ? popularSeries : mergeByIdGeneric(popularSeries, existing?.popularSeries || []);
    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: existing?.channels || [],
      popularMovies: existing?.popularMovies || [],
      popularSeries: finalPopularSeries,
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    updateSyncProgress('popularSeries', finalPopularSeries.length, `${finalPopularSeries.length} series populares guardadas`);
    return finalPopularSeries.length;
  });
}

async function validateBatchBatched(channels: LiveChannel[], batchSize = 30): Promise<LiveChannel[]> {
  const valid: LiveChannel[] = [];
  for (let i = 0; i < channels.length; i += batchSize) {
    const batch = channels.slice(i, i + batchSize);
    const result = await validateBatch(batch);
    valid.push(...result);
  }
  logger.info({ total: valid.length }, 'Import batch validation complete');
  return valid;
}

export async function syncHomeByscHandler(_request: FastifyRequest, reply: FastifyReply) {
  if (!startSync('home')) {
    return reply.send({ ok: true, message: 'Home sync already in progress' });
  }

  reply.send({ ok: true, message: 'Home sync started' });

  runBackgroundSync('home', async () => {
    updateSyncProgress('home', 0, 'Scrapeando datos de cineby.sc...');
    const { scrapeCinebyHome, saveCinebyHomeData } = await import('../../providers/cineby');
    const data = await scrapeCinebyHome();
    updateSyncProgress('home', 1, 'Guardando datos...');
    await saveCinebyHomeData(data);
    const count = Object.keys(data.sections || {}).length || data.banner?.length || 0;
    updateSyncProgress('home', count, `${count} secciones guardadas`);
    return count;
  });
}

// ---- GNULA HD ----

/** Preserva todas las colecciones al hacer saveSyncData (incluidas las de GNULA). */
function buildSyncData(existing: SyncData | null, patch: Partial<SyncData>): SyncData {
  return {
    movies: existing?.movies || [],
    series: existing?.series || [],
    channels: existing?.channels || [],
    popularMovies: existing?.popularMovies || [],
    popularSeries: existing?.popularSeries || [],
    estrenoMovies: existing?.estrenoMovies || [],
    estrenoSeries: existing?.estrenoSeries || [],
    gnulahdMovies: existing?.gnulahdMovies || [],
    gnulahdSeries: existing?.gnulahdSeries || [],
    gnulahdAnime: existing?.gnulahdAnime || [],
    updatedAt: Date.now(),
    ...patch,
  };
}

async function syncGnulahdList(
  kind: 'peliculas' | 'series' | 'anime',
  pages: number[],
  type: SyncType,
): Promise<SyncMovie[] | SyncSeries[]> {
  const { scrapeGnulahdList, scrapeGnulahdDetail } = await import('../../providers/gnulahd');
  const isSeries = kind !== 'peliculas';

  const allItems: { id: string; title: string; poster?: string; rating?: number; year?: number }[] = [];
  for (const page of pages) {
    const pageData = await scrapeGnulahdList(kind, page);
    for (const item of pageData.items) {
      allItems.push({ id: item.id, title: item.title, poster: item.poster, rating: item.rating, year: item.year });
    }
    updateSyncProgress(type, allItems.length, `Escaneando página ${page} de ${kind}...`);
    logger.info({ kind, page, total: allItems.length }, 'Gnulahd list page synced');
  }

  const results: (SyncMovie | SyncSeries)[] = [];
  let processed = 0;

  await processBatch(allItems, async (item) => {
    try {
      const detail = await scrapeGnulahdDetail(item.id);
      processed++;
      updateSyncProgress(type, processed, `Procesando detalles (${processed}/${allItems.length})...`, allItems.length);
      if (detail) {
        if (isSeries) {
          results.push({
            id: detail.id,
            title: detail.title,
            poster: detail.poster || item.poster,
            backdrop: detail.backdrop || item.poster,
            rating: detail.rating,
            year: detail.year,
            description: detail.description,
            genres: detail.genres,
            cast: detail.cast,
            country: detail.country,
            seasons: detail.seasons,
            videos: detail.videos,
            downloads: detail.downloads,
          });
        } else {
          results.push({
            id: detail.id,
            title: detail.title,
            poster: detail.poster || item.poster,
            backdrop: detail.backdrop || item.poster,
            rating: detail.rating,
            year: detail.year,
            description: detail.description,
            genres: detail.genres,
            cast: detail.cast,
            duration: detail.duration,
            country: detail.country,
            videos: detail.videos,
            downloads: detail.downloads,
          });
        }
        return;
      }
    } catch { /* fallback below */ }

    results.push({
      id: item.id,
      title: item.title,
      poster: item.poster,
      rating: item.rating,
      year: item.year,
    } as SyncMovie);
  });

  updateSyncProgress(type, results.length, `${results.length} items de ${kind} procesados`);
  return results;
}

export async function syncGnulahdHomeHandler(_request: FastifyRequest, reply: FastifyReply) {
  if (!startSync('gnulahdHome')) {
    return reply.send({ ok: true, message: 'Gnulahd home sync already in progress' });
  }

  reply.send({ ok: true, message: 'Gnulahd home sync started' });

  runBackgroundSync('gnulahdHome', async () => {
    updateSyncProgress('gnulahdHome', 0, 'Scrapeando home de gnulahd.nu...');
    const { scrapeGnulahdHome, saveGnulahdHomeData } = await import('../../providers/gnulahd');
    const data = await scrapeGnulahdHome();
    updateSyncProgress('gnulahdHome', 1, 'Guardando datos...');
    await saveGnulahdHomeData(data);
    const count = data.banners.length + data.sections.length;
    updateSyncProgress('gnulahdHome', count, `${count} banners/secciones guardadas`);
    return count;
  });
}

async function syncGnulahdByKindHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  kind: 'peliculas' | 'series' | 'anime',
  type: SyncType,
  field: 'gnulahdMovies' | 'gnulahdSeries' | 'gnulahdAnime',
) {
  const body = request.body as { pages?: string; replace?: boolean } | undefined;
  const pages = parsePages(body?.pages);
  if (pages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  if (!startSync(type)) {
    return reply.send({ ok: true, message: `${type} sync already in progress` });
  }

  reply.send({ ok: true, message: `${type} sync started` });

  runBackgroundSync(type, async () => {
    const items = await syncGnulahdList(kind, pages, type);
    const existing = await loadSyncData();
    const shouldReplace = body?.replace === true;
    const current = (existing && existing[field]) || [];
    const finalItems = shouldReplace ? items : mergeByIdGeneric(items as { id: string }[], current as { id: string }[]);
    await saveSyncData(buildSyncData(existing, { [field]: finalItems } as Partial<SyncData>));
    return finalItems.length;
  });
}

export async function syncGnulahdMoviesHandler(request: FastifyRequest, reply: FastifyReply) {
  return syncGnulahdByKindHandler(request, reply, 'peliculas', 'gnulahdMovies', 'gnulahdMovies');
}

export async function syncGnulahdSeriesHandler(request: FastifyRequest, reply: FastifyReply) {
  return syncGnulahdByKindHandler(request, reply, 'series', 'gnulahdSeries', 'gnulahdSeries');
}

export async function syncGnulahdAnimeHandler(request: FastifyRequest, reply: FastifyReply) {
  return syncGnulahdByKindHandler(request, reply, 'anime', 'gnulahdAnime', 'gnulahdAnime');
}

function collectItems(obj: any, acc: { id: number; mediaType: string; slug: string; title: string }[]) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach(item => collectItems(item, acc));
  } else {
    if (obj.id && obj.slug && obj.mediaType) {
      acc.push({ id: obj.id, mediaType: obj.mediaType, slug: obj.slug, title: obj.title || '' });
    }
    for (const key of Object.keys(obj)) {
      collectItems(obj[key], acc);
    }
  }
}

function enrichItem(obj: any, detailMap: Map<number, any>) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach(item => enrichItem(item, detailMap));
  } else {
    if (obj.id && detailMap.has(obj.id)) {
      const d = detailMap.get(obj.id)!;
      obj.description = d.description || obj.description || '';
      obj.videoUrl = d.videoUrl || obj.videoUrl || '';
      obj.genres = d.genres || obj.genres || [];
      obj.originalTitle = d.originalTitle || obj.originalTitle || '';
      obj.imdbId = d.imdbId || obj.imdbId || '';
    }
    for (const key of Object.keys(obj)) {
      enrichItem(obj[key], detailMap);
    }
  }
}

export async function fetchDetailsHandler(
  request: FastifyRequest<{ Body: { file?: string } }>,
  reply: FastifyReply
) {
  try {
    if (!startSync('fetchDetails')) {
      return reply.send({ ok: true, message: 'Fetch details already in progress' });
    }
    reply.send({ ok: true, message: 'Fetch details started, running in background...' });

    runBackgroundSync('fetchDetails', async () => {
      const homeData = await loadHomeData<any>();
      if (!homeData) {
        throw new Error('Home data not found. Run /sync/home-bysc first.');
      }

      const allItems: { id: number; mediaType: string; slug: string; title: string }[] = [];
      collectItems(homeData, allItems);
      updateSyncProgress('fetchDetails', 0, `${allItems.length} items encontrados, obteniendo detalles...`);

      const details = await fetchItemDetails(allItems);
      updateSyncProgress('fetchDetails', details.length, `${details.length} detalles obtenidos, enriqueciendo...`);
      const detailMap = new Map(details.map(d => [d.id, d]));
      enrichItem(homeData, detailMap);

      await saveHomeData(homeData);
      updateSyncProgress('fetchDetails', details.length, `${details.length} items enriquecidos`);
      return details.length;
    });

    return;
  } catch (error) {
    logger.error({ error }, 'Fetch details failed');
    return reply.status(500).send({ error: 'Failed to fetch details' });
  }
}

export async function importM3UHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { url?: string; content?: string; country?: string; skipValidation?: boolean } | undefined;
  if (!body?.url && !body?.content) {
    return reply.status(400).send({ error: 'Provide "url" or "content" with .m3u data' });
  }
  if (!startSync('importM3U')) {
    return reply.send({ ok: true, message: 'Import already in progress' });
  }

  reply.send({ ok: true, message: 'M3U import started' });

  runBackgroundSync('importM3U', async () => {
    let rawContent: string;
    const sourceCountry: string | undefined = body.country;

    updateSyncProgress('importM3U', 0, 'Descargando lista M3U...');
    if (body.url) {
      rawContent = await fetchHTML(body.url);
    } else {
      rawContent = body.content!;
    }

    updateSyncProgress('importM3U', 0, 'Parseando canales...');
    const parsed = parseM3U(rawContent, sourceCountry);
    if (parsed.length === 0) {
      logger.warn('No channels found in M3U data');
      return 0;
    }

    const channels: LiveChannel[] = parsed.map((ch, idx) => ({
      id: `import_${idx + 1}`,
      title: ch.title,
      logo: ch.logo,
      group: ch.group || 'General',
      url: ch.url,
      country: ch.country?.toUpperCase(),
      type: 'live' as const,
      online: true,
    }));

    updateSyncProgress('importM3U', channels.length, `${channels.length} canales parseados, validando...`);

    const toAdd = body.skipValidation ? channels : await validateBatchBatched(channels);
    if (toAdd.length === 0) {
      logger.info('No valid channels found in M3U data');
      return 0;
    }

    updateSyncProgress('importM3U', toAdd.length, `${toAdd.length} canales válidos, guardando...`);

    const existing = await loadSyncData();
    const existingChannels = existing?.channels || [];
    const existingTitles = new Set(existingChannels.map((ch) => ch.title.toLowerCase().trim()));

    const newChannels: LiveChannel[] = [];
    let skipped = 0;
    for (const ch of toAdd) {
      if (existingTitles.has(ch.title.toLowerCase().trim())) {
        skipped++;
      } else {
        ch.id = `live_${existingChannels.length + newChannels.length + 1}`;
        newChannels.push(ch);
      }
    }

    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: [...existingChannels, ...newChannels],
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });

    updateSyncProgress('importM3U', newChannels.length, `${newChannels.length} canales importados (${skipped} omitidos)`);
    logger.info({ imported: newChannels.length, skipped }, 'M3U import completed');
    return newChannels.length;
  });
}

export const DASHBOARD_CODE = '1992';

export async function syncStatusHandler(request: FastifyRequest, reply: FastifyReply) {
  const accept = request.headers.accept || '';

  if (!accept.includes('text/html')) {
    return reply.send(getSyncStatus());
  }

  const query = request.query as { code?: string };
  if (query.code !== DASHBOARD_CODE) {
    return reply.type('text/html').send(generateCodeEntryPage());
  }

  const status = getSyncStatus();

  const syncDefs: {
    key: string; label: string; route: string; method: string;
    needsPages?: boolean; needsUrl?: boolean; needsBody?: boolean; needsId?: boolean; needsJson?: boolean; needsProvider?: boolean;
  }[] = [
    { key: 'movies', label: 'Películas', route: '/sync/movies', method: 'POST', needsPages: true },
    { key: 'series', label: 'Series', route: '/sync/series', method: 'POST', needsPages: true },
    { key: 'all', label: 'Todo (Películas+Series)', route: '/sync/all', method: 'POST', needsPages: true },
    { key: 'estrenoMovies', label: 'Estrenos Películas', route: '/sync/estrenos/movies', method: 'POST', needsPages: true },
    { key: 'estrenoSeries', label: 'Estrenos Series', route: '/sync/estrenos/series', method: 'POST', needsPages: true },
    { key: 'channels', label: 'TV en Vivo', route: '/sync/live', method: 'POST' },
    { key: 'popularMovies', label: 'Populares Películas', route: '/sync/popular/movies', method: 'POST' },
    { key: 'popularSeries', label: 'Populares Series', route: '/sync/popular/series', method: 'POST' },
    { key: 'home', label: 'Home (cineby.sc)', route: '/sync/home-bysc', method: 'POST' },
    { key: 'gnulahdHome', label: 'Home (gnulahd)', route: '/sync/gnulahd/home', method: 'POST' },
    { key: 'gnulahdMovies', label: 'Gnulahd Películas', route: '/sync/gnulahd/movies', method: 'POST', needsPages: true },
    { key: 'gnulahdSeries', label: 'Gnulahd Series', route: '/sync/gnulahd/series', method: 'POST', needsPages: true },
    { key: 'gnulahdAnime', label: 'Gnulahd Anime', route: '/sync/gnulahd/anime', method: 'POST', needsPages: true },
    { key: 'fetchDetails', label: 'Fetch Details (cineby)', route: '/sync/fetch-details', method: 'POST' },
    { key: 'importM3U', label: 'Importar M3U', route: '/sync/live/import', method: 'POST', needsUrl: true },
    { key: 'refreshAll', label: 'Refresh All Canales', route: '/live/channels/refresh-all', method: 'POST' },
    { key: 'refreshExpired', label: 'Refresh Expired Canales', route: '/live/channels/refresh-expired', method: 'POST' },
    { key: 'refreshProvider', label: 'Refresh por Proveedor', route: '/live/channels/refresh-provider/{provider}', method: 'POST', needsProvider: true },
    { key: 'refreshOne', label: 'Refresh Canal (por ID)', route: '/live/channels/refresh', method: 'POST', needsId: true },
    { key: 'updateChannel', label: 'Actualizar Canal (PATCH)', route: '/live/channels/{id}', method: 'PATCH', needsId: true, needsJson: true },
  ];

  const autoCfg = await getAutoRefreshConfig();

  return reply.type('text/html').send(generateSyncDashboard(status, syncDefs, migrationStatus, firestoreMigrationStatus, autoCfg));
}

export async function syncCountsHandler(_request: FastifyRequest, reply: FastifyReply) {
  const counts = await getCollectionCounts();
  return reply.send(counts);
}

export async function syncCountHandler(request: FastifyRequest, reply: FastifyReply) {
  const { type } = request.params as { type: string };
  const count = await getCollectionCount(type);
  if (count == null) {
    return reply.status(404).send({ error: 'Unknown collection', type });
  }
  return reply.send({ key: type, count });
}

export async function getAutoRefreshHandler(_request: FastifyRequest, reply: FastifyReply) {
  const config = await getAutoRefreshConfig();
  return reply.send(config);
}

export async function setAutoRefreshHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = (request.body || {}) as { enabled?: unknown; intervalMinutes?: unknown; providers?: unknown };

  let providers: Record<string, number> | undefined;
  if (body.providers && typeof body.providers === 'object') {
    providers = {};
    for (const [name, value] of Object.entries(body.providers as Record<string, unknown>)) {
      if (!(REFRESH_PROVIDERS as readonly string[]).includes(name)) continue;
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1) providers[name] = Math.floor(n);
    }
  }

  const config = await setAutoRefreshConfig({
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    intervalMinutes: typeof body.intervalMinutes === 'number' ? body.intervalMinutes : undefined,
    providers,
  });
  return reply.send({ ok: true, ...config });
}

export async function syncDetailHandler(request: FastifyRequest, reply: FastifyReply) {
  const { type } = request.params as { type: string };
  const logEntries = getLogs(type);
  const accept = request.headers.accept || '';

  if (accept.includes('text/html')) {
    const logHtml = logEntries.map(line =>
      `<div class="line">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`
    ).join('\n');

    return reply.type('text/html').send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Detalle: ${type}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Courier New',monospace;background:#0d1117;color:#e6edf3;padding:1rem;font-size:.85rem}
h1{color:#58a6ff;margin-bottom:1rem;font-size:1.2rem}
.terminal{background:#161b22;border-radius:8px;padding:1rem;border:1px solid #30363d;max-height:80vh;overflow-y:auto}
.line{padding:2px 0;line-height:1.5;word-break:break-all}
.line:nth-child(even){background:rgba(255,255,255,.02)}
a{color:#58a6ff;text-decoration:none;margin-bottom:1rem;display:inline-block}
a:hover{text-decoration:underline}
.auto-refresh{color:#8b949e;font-size:.75rem;margin-bottom:.5rem}
</style>
</head>
<body>
<a href="/sync/status?code=1992">← Volver al Dashboard</a>
<h1>📋 Detalle: ${type}</h1>
<div class="auto-refresh" id="dbCount" style="color:#7ee787"></div>
<div class="auto-refresh" id="status">Actualizando automáticamente... <button id="toggleBtn" onclick="togglePause()" style="margin-left:.5rem;cursor:pointer;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:2px 8px;font-size:.7rem">⏸ Pausar</button> <button id="copyBtn" onclick="copyLogs()" style="margin-left:.5rem;cursor:pointer;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:2px 8px;font-size:.7rem">📋 Copiar logs</button></div>
<div class="terminal" id="logContainer">${logHtml || '<div class="line" style="color:#8b949e">Sin registros aún</div>'}</div>
<script>
// Consulta UN solo conteo de Firestore al abrir el Detalle (por eso el dashboard ya no consulta nada)
(function loadDbCount(){
  const map = { refreshAll:'channels', refreshExpired:'channels', refreshOne:'channels', refreshProvider:'channels', importM3U:'channels', updateChannel:'channels', channels:'channels', movies:'movies', series:'series', popularMovies:'popularMovies', popularSeries:'popularSeries', estrenoMovies:'estrenoMovies', estrenoSeries:'estrenoSeries', gnulahdMovies:'gnulahdMovies', gnulahdSeries:'gnulahdSeries', gnulahdAnime:'gnulahdAnime' };
  const coll = map['${type}'];
  if (!coll) return;
  fetch('/sync/count/' + coll).then(function(r){ return r.json(); }).then(function(d){
    if (d && d.count != null) document.getElementById('dbCount').textContent = 'Total en BD (' + coll + '): ' + d.count;
  }).catch(function(){});
})();
let prevLen = 0;
let autoScroll = true;
let paused = false;
let timer = null;
const logEl = document.getElementById('logContainer');
logEl.addEventListener('scroll', function() {
  const el = this;
  autoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
});
// Si el usuario empieza a seleccionar texto dentro del terminal, se pausa
// el auto-refresh para que la reconstrucción del DOM no cancele la selección.
logEl.addEventListener('mousedown', function() {
  if (paused || timer === null) return;
  setPaused(true);
});
async function checkDone() {
  try {
    const res = await fetch('/sync/status');
    if (res.ok) {
      const data = await res.json();
      const st = data['${type}'];
      if (st && (st.status === 'completed' || st.status === 'failed')) {
        if (timer) clearInterval(timer);
        timer = null;
        const el = document.getElementById('status');
        el.firstChild.textContent = st.status === 'completed' ? '✅ Sincronización finalizada (auto-refresh detenido)' : '⛔ Sincronización fallida (auto-refresh detenido)';
        document.getElementById('toggleBtn').style.display = 'none';
      }
    }
  } catch {}
}
function setPaused(value) {
  paused = value;
  document.getElementById('toggleBtn').textContent = paused ? '▶ Reanudar' : '⏸ Pausar';
  const el = document.getElementById('status');
  el.firstChild.textContent = paused ? '⏸ En pausa (puedes seleccionar/copiar texto)' : 'Actualizando automáticamente...';
  if (paused) {
    if (timer) { clearInterval(timer); timer = null; }
  } else {
    refreshLogs(true);
    checkDone();
    timer = setInterval(tick, 1500);
  }
}
function togglePause() {
  setPaused(!paused);
}
function copyLogs() {
  const text = document.getElementById('logContainer').innerText;
  const done = function () {
    const btn = document.getElementById('copyBtn');
    btn.textContent = '✅ Copiado';
    setTimeout(function () { btn.textContent = '📋 Copiar logs'; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
  } else {
    fallbackCopy(text);
    done();
  }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}
async function tick() {
  await refreshLogs();
  checkDone();
}
async function refreshLogs(force) {
  try {
    const res = await fetch('/sync/detail/${type}');
    if (res.ok) {
      const data = await res.json();
      const hasNew = data.length !== prevLen;
      prevLen = data.length;
      if (!hasNew && !force) return;
      const container = document.getElementById('logContainer');
      container.innerHTML = data.map(line =>
        '<div class="line">' + line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>'
      ).join('') || '<div class="line" style="color:#8b949e">Sin registros aún</div>';
      if (autoScroll) container.scrollTop = container.scrollHeight;
    }
  } catch {}
}
refreshLogs(true);
timer = setInterval(tick, 1500);
checkDone();
</script>
</body>
</html>`);
  }

  return reply.send(logEntries);
}

export async function clearLogsHandler(request: FastifyRequest, reply: FastifyReply) {
  const { type } = request.params as { type: string };
  if (!type) {
    return reply.status(400).send({ error: 'type is required' });
  }
  clearLogs(type);
  return reply.send({ ok: true, cleared: type });
}

export function generateCodeEntryPage(): string {  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Acceso</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:#0f0c29;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.container{background:rgba(255,255,255,.05);border-radius:16px;padding:2.5rem;width:90%;max-width:380px;
  backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1);text-align:center}
h1{font-size:1.5rem;margin-bottom:.5rem;background:linear-gradient(135deg,#667eea,#764ba2);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
p{color:#888;margin-bottom:1.5rem;font-size:.9rem}
input[type=password]{width:100%;padding:.8rem;border-radius:8px;border:1px solid rgba(255,255,255,.15);
  background:rgba(255,255,255,.05);color:#fff;font-size:1.2rem;text-align:center;letter-spacing:4px;margin-bottom:1rem}
input[type=password]:focus{outline:none;border-color:#667eea}
.btn{width:100%;padding:.8rem;border-radius:8px;border:none;cursor:pointer;font-size:1rem;font-weight:600;
  background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;transition:opacity .2s}
.btn:hover{opacity:.85}
.error{color:#f87171;font-size:.85rem;margin-top:.5rem;display:none}
</style>
</head>
<body>
<div class="container">
<h1>🔐 Acceso Restringido</h1>
<p>Ingresa el código de acceso</p>
<form id="codeForm" onsubmit="return checkCode()">
<input type="password" id="codeInput" placeholder="Código" maxlength="10" autofocus>
<button class="btn" type="submit">Ingresar</button>
<div class="error" id="errorMsg">Código incorrecto</div>
</form>
</div>
<script>
function checkCode() {
  const code = document.getElementById('codeInput').value;
  if (code === '1992') {
    window.location.href = '/sync/status?code=' + code;
    return false;
  }
  document.getElementById('errorMsg').style.display = 'block';
  return false;
}
document.getElementById('codeInput').addEventListener('keydown', function(e) {
  document.getElementById('errorMsg').style.display = 'none';
});
</script>
</body>
</html>`;
}

function generateSyncDashboard(
  status: Record<string, { status: string; lastRun: number | null; duration?: number; count?: number; error?: string; progress?: { current: number; total?: number; message: string } }>,
  syncDefs: { key: string; label: string; route: string; method: string; needsPages?: boolean; needsUrl?: boolean; needsBody?: boolean; needsId?: boolean; needsJson?: boolean; needsProvider?: boolean }[],
  migStatus: MigrationStatus,
  fsMigStatus: FirestoreMigrationStatus,
  autoCfg: AutoRefreshConfig,
): string {
  const statusBadge = (s: string) => {
    const map: Record<string, string> = { idle: '⚪', running: '🟡', completed: '🟢', failed: '🔴' };
    return map[s] || '⚪';
  };

  const rows = syncDefs.map(def => {
    const s = status[def.key];
    const isRunning = s?.status === 'running';
    const badge = statusBadge(s?.status || 'idle');
    const lastRun = s?.lastRun ? new Date(s.lastRun).toLocaleString() : '—';
    const info = s?.count ? `${s.count} items` : s?.error || '';
    const prog = s?.progress;
    const hasParams = def.needsPages || def.needsUrl || def.needsBody || def.needsId || def.needsJson || def.needsProvider;
    return `
    <div class="card-wrap" id="wrap-${def.key}">
    <div class="card" id="card-${def.key}">
      <div class="card-header">
        <span class="drag-handle" draggable="true" title="Arrastrar para reordenar">⠿</span>
        <span class="badge">${badge}</span>
        <span class="card-title">${def.label}</span>
        <span class="status-text ${s?.status}">${s?.status || 'idle'}</span>
        <button class="card-hide-btn" id="hidebtn-${def.key}" onclick="toggleCardHide('${def.key}')" title="Ocultar tarjeta">🚫</button>
      </div>
      <div class="card-body">
        <div class="card-row"><span class="label">Última ejecución</span><span>${lastRun}</span></div>
        ${s?.duration ? `<div class="card-row"><span class="label">Duración</span><span>${(s.duration / 1000).toFixed(1)}s</span></div>` : ''}
        <div class="card-row" id="row-items-${def.key}"><span class="label">Items</span><span class="count-val">${s?.count != null ? s.count : (s?.error ? '—' : '0')}</span></div>
        ${s?.error ? `<div class="card-row" id="row-error-${def.key}"><span class="label">Error</span><span class="error">${s.error}</span></div>` : ''}
        <div class="progress-row" id="prog-${def.key}" ${isRunning && prog ? '' : 'style="display:none"'}>
          <span class="progress-msg">${isRunning && prog ? prog.message : ''}</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-primary btn-sm" onclick="runSync('${def.key}','${def.route}','${def.method}','${def.needsId ? 'id' : def.needsJson ? 'json' : def.needsPages ? 'pages' : def.needsProvider ? 'provider' : ''}')" ${isRunning ? 'disabled' : ''}>
          ${isRunning ? (prog ? prog.message : 'Ejecutando...') : '▶ Ejecutar'}
        </button>
        ${hasParams ? `<button class="btn btn-secondary btn-sm" onclick="showParamsModal('${def.key}','${def.route}','${def.label}','${def.method}','${def.needsId ? '1' : ''}','${def.needsJson ? '1' : ''}','${def.needsProvider ? '1' : ''}')">⚙ Parámetros</button>` : ''}
        ${def.key === 'refreshAll' || def.key === 'refreshExpired' || def.key === 'refreshOne' || def.key === 'refreshProvider' ? `<a href="/sync/detail/${def.key}" class="btn btn-secondary btn-sm" style="text-decoration:none">📋 Detalle</a>` : ''}
      </div>
    </div>
    </div>`;
  }).join('\n');

  const migRunning = migStatus.running;
  const migBadge = migRunning ? '🟡' : migStatus.progress === 'completed' ? '🟢' : migStatus.progress === 'error' ? '🔴' : '⚪';
  const migMsg = migRunning ? 'Migrando...' : migStatus.progress === 'completed' ? 'Completado' : migStatus.progress === 'error' ? 'Error' : 'Inactivo';

  const fsRunning = fsMigStatus.running;
  const fsBadge = fsRunning ? '🟡' : fsMigStatus.progress === 'completed' ? '🟢' : fsMigStatus.progress === 'error' ? '🔴' : '⚪';
  const fsMsg = fsRunning ? 'Migrando...' : fsMigStatus.progress === 'completed' ? 'Completado' : fsMigStatus.progress === 'error' ? 'Error' : fsMigStatus.progress === 'reading' || fsMigStatus.progress === 'writing' ? 'En curso' : 'Inactivo';
  const fsBarWidth = fsMigStatus.progress === 'idle' ? 0 : fsMigStatus.progress === 'completed' || fsMigStatus.progress === 'error' ? 100 : 55;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sync Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:#0f0c29;color:#e0e0e0;min-height:100vh;padding:2rem}
h1{font-size:1.8rem;margin-bottom:2rem;background:linear-gradient(135deg,#667eea,#764ba2);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.dashboard{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:1rem}
.card{background:rgba(255,255,255,.05);border-radius:12px;padding:1.2rem;
  backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08)}
.card-wrap.dragging{opacity:.45;transform:scale(.98)}
.card-wrap.drag-over{outline:2px dashed #667eea;outline-offset:3px;border-radius:14px}
.card-wrap.card-hidden{display:none}
.drag-handle{cursor:grab;color:#6e6e8e;font-size:1rem;line-height:1;user-select:none;padding:0 .2rem}
.drag-handle:active{cursor:grabbing}
.card-hide-btn{background:none;border:none;cursor:pointer;font-size:.95rem;color:#888;padding:.1rem .3rem;border-radius:6px;margin-left:auto}
.card-hide-btn:hover{background:rgba(255,255,255,.1);color:#fff}
#hiddenBar{display:none;margin-bottom:1rem;font-size:.85rem;color:#888;align-items:center;gap:.5rem;flex-wrap:wrap}
#hiddenBar a{color:#667eea;cursor:pointer;margin-right:.6rem;text-decoration:none}
#hiddenBar a:hover{text-decoration:underline}
.card-header{display:flex;align-items:center;gap:.6rem;margin-bottom:.8rem}
.badge{font-size:1.2rem}
.card-title{font-weight:600;font-size:1.05rem;flex:1}
.status-text{font-size:.8rem;padding:.2rem .6rem;border-radius:4px;text-transform:capitalize}
.status-text.running{background:rgba(251,191,36,.15);color:#fbbf24}
.status-text.completed{background:rgba(52,211,153,.15);color:#34d399}
.status-text.failed{background:rgba(248,113,113,.15);color:#f87171}
.status-text.idle{background:rgba(156,163,175,.15);color:#9ca3af}
.card-body{font-size:.9rem;margin-bottom:.8rem}
.card-row{display:flex;justify-content:space-between;padding:.3rem 0;border-bottom:1px solid rgba(255,255,255,.04)}
.card-row .label{color:#888}
.card-row .error{color:#f87171}
.progress-row{padding:.4rem 0}
.progress-msg{display:block;font-size:.82rem;color:#fbbf24;background:rgba(251,191,36,.1);padding:.3rem .6rem;border-radius:4px;text-align:center}
.card-actions{display:flex;gap:.5rem;flex-wrap:wrap}
.btn{padding:.5rem 1rem;border-radius:6px;border:none;cursor:pointer;font-size:.85rem;font-weight:600;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-primary{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
.btn-secondary{background:rgba(255,255,255,.1);color:#e0e0e0}
.btn-danger{background:linear-gradient(135deg,#f87171,#dc2626);color:#fff}

/* Migration card */
.migration-section{margin-top:2rem}
.migration-card{background:rgba(255,255,255,.05);border-radius:12px;padding:1.2rem;
  backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);max-width:600px}
.migration-card .bar{height:6px;background:rgba(255,255,255,.1);border-radius:3px;margin:.8rem 0;overflow:hidden}
.migration-card .bar-fill{height:100%;border-radius:3px;transition:width .5s;background:linear-gradient(90deg,#667eea,#764ba2)}
.migration-card .bar-fill.completed{background:linear-gradient(90deg,#34d399,#059669)}
.migration-card .bar-fill.error{background:linear-gradient(90deg,#f87171,#dc2626)}
.migration-card .msg{padding:.5rem;border-radius:6px;font-size:.85rem;margin-top:.5rem}
.migration-card .msg.info{background:rgba(96,165,250,.15);color:#93c5fd}
.migration-card .msg.success{background:rgba(52,211,153,.15);color:#6ee7b7}
.migration-card .msg.error{background:rgba(248,113,113,.15);color:#fca5a5}

/* Modal */
.modal-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;
  background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center}
.modal-overlay.active{display:flex}
.modal{background:#1e1b4b;border-radius:12px;padding:2rem;width:90%;max-width:420px;
  border:1px solid rgba(255,255,255,.1);position:relative}
.modal-close{position:absolute;top:.6rem;right:.6rem;background:none;border:none;color:#aaa;
  font-size:1.2rem;cursor:pointer;padding:.3rem .55rem;border-radius:6px}
.modal-close:hover{background:rgba(255,255,255,.1);color:#fff}
.modal h2{margin-bottom:1rem;font-size:1.2rem}
.modal label{display:block;margin-bottom:.5rem;color:#aaa;font-size:.9rem}
.modal input[type=text]{width:100%;padding:.7rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);
  background:rgba(255,255,255,.05);color:#fff;font-size:.95rem;margin-bottom:1rem}
.modal input[type=text]:focus{outline:none;border-color:#667eea}
.modal select{width:100%;padding:.7rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);
  background:rgba(255,255,255,.05);color:#fff;font-size:.95rem;margin-bottom:1rem}
.modal select option{background:#1e1b4b;color:#fff}
.uc-field-row{display:flex;gap:.5rem;margin-bottom:.6rem;align-items:center}
.uc-field-row select{flex:0 0 150px;margin-bottom:0;padding:.5rem}
.uc-field-row .uc-field-value{flex:1;padding:.5rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);
  background:rgba(255,255,255,.05);color:#fff;font-size:.9rem}
.uc-field-row .uc-field-value:focus{outline:none;border-color:#667eea}
.modal-actions{margin-top:.5rem}
.modal-actions .btn-sm{padding:.35rem .7rem;font-size:.8rem}
#ucChannelInfo{margin-top:-.6rem;margin-bottom:.6rem}
.modal-actions{display:flex;gap:.7rem;margin-top:.5rem}
.form-hint{font-size:.8rem;color:#888;margin-top:-.5rem;margin-bottom:.8rem}
</style>
</head>
<body>
<h1>🔄 Panel de Sincronización</h1>
<div style="margin-bottom:1.5rem">
  <a href="/db?code=1992" style="display:inline-block;padding:.5rem 1rem;border-radius:8px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;text-decoration:none;font-size:.9rem;font-weight:600">🗄️ Explorador de Base de Datos</a>
</div>
<div class="dashboard" id="dashboard">
  ${rows}
</div>
<div id="hiddenBar">
  <span>👁 Ocultas:</span>
  <span id="hiddenList"></span>
  <button class="btn btn-secondary btn-sm" onclick="unhideAllCards()">Mostrar todas</button>
</div>

<div class="migration-section">
  <h2 style="margin-bottom:1rem;font-size:1.2rem;color:#a0a0c0">⏱️ Refresh automático por proveedor</h2>
  <div class="migration-card">
    <div class="card-header">
      <span class="badge" id="arBadge">${autoCfg.enabled ? '🟢' : '🔴'}</span>
      <span class="card-title">Refrescar canales automáticamente (por proveedor)</span>
      <span class="status-text ${autoCfg.enabled ? 'completed' : 'failed'}" id="arStatus">${autoCfg.enabled ? 'activo' : 'pausado'}</span>
    </div>
    <div class="card-body">
      <label style="display:flex;align-items:center;gap:.8rem;cursor:pointer">
        <input type="checkbox" id="arToggle" ${autoCfg.enabled ? 'checked' : ''} onchange="saveAutoRefresh()" style="width:22px;height:22px;accent-color:#667eea">
        <span id="arLabel" style="font-size:.95rem">${autoCfg.enabled ? 'Activado' : 'Pausado'}</span>
      </label>
      <div id="arRows" style="margin-top:.6rem">
        ${REFRESH_PROVIDERS.map((name) => {
          const minutes = autoCfg.providers[name];
          const lastRun = autoCfg.providerLastRuns[name];
          const lastText = lastRun
            ? `último: ${new Date(lastRun).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
            : 'sin ejecutar';
          return `<div style="display:flex;align-items:center;gap:.8rem;padding:.45rem 0;border-bottom:1px solid rgba(255,255,255,.06)">
            <input type="checkbox" id="arP-${name}" ${minutes ? 'checked' : ''} onchange="saveAutoRefresh()" style="width:18px;height:18px;accent-color:#667eea">
            <label for="arP-${name}" style="font-size:.95rem;flex:0 0 160px">${name}</label>
            <input type="number" id="arM-${name}" min="1" step="1" value="${minutes || ''}" placeholder="min" onchange="saveAutoRefresh()" style="width:80px;padding:.4rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#fff;font-size:.9rem">
            <span style="font-size:.75rem;color:#888">${lastText}</span>
          </div>`;
        }).join('\n')}
      </div>
      <div style="display:flex;align-items:center;gap:.8rem;margin-top:.8rem">
        <button class="btn btn-secondary btn-sm" onclick="refreshAutoRefreshState(true)">🔄 Consultar estado</button>
        <span id="arHint" style="font-size:.8rem;color:#888">—</span>
      </div>
    </div>
  </div>
</div>

<div class="migration-section">
  <h2 style="margin-bottom:1rem;font-size:1.2rem;color:#a0a0c0">🚀 Migración a Firestore</h2>
  <div class="migration-card">
    <div class="card-header">
      <span class="badge">${migBadge}</span>
      <span class="card-title">Migración desde sync-data.json</span>
      <span class="status-text ${migStatus.progress === 'completed' ? 'completed' : migStatus.progress === 'error' ? 'failed' : migRunning ? 'running' : 'idle'}">${migMsg}</span>
    </div>
    <div class="card-body">
      ${migStatus.message ? `<div class="msg ${migStatus.progress === 'error' ? 'error' : migStatus.progress === 'completed' ? 'success' : 'info'}">${migStatus.message}</div>` : ''}
      <div class="bar">
        <div class="bar-fill ${migStatus.progress === 'completed' ? 'completed' : ''} ${migStatus.progress === 'error' ? 'error' : ''}"
             style="width:${migStatus.progress === 'idle' ? 0 : migStatus.progress === 'completed' || migStatus.progress === 'error' ? 100 : 60}%"></div>
      </div>
    </div>
    <div class="card-actions">
      <button class="btn btn-danger" onclick="runMigration()" ${migRunning ? 'disabled' : ''}>
        ${migRunning ? 'Migrando...' : '▶ Ejecutar Migración'}
      </button>
      <a href="/sync/migration-status" class="btn btn-secondary" style="text-decoration:none">📊 Detalle</a>
    </div>
  </div>
</div>

<div class="migration-section">
  <h2 style="margin-bottom:1rem;font-size:1.2rem;color:#a0a0c0">🚚 Migrar Firestore a Supabase</h2>
  <div class="migration-card" id="smigCard">
    <div class="card-header">
      <span class="badge" id="smigBadge">${fsBadge}</span>
      <span class="card-title">Desde Firestore hacia Supabase</span>
      <span class="status-text ${fsMigStatus.progress === 'completed' ? 'completed' : fsMigStatus.progress === 'error' ? 'failed' : fsRunning ? 'running' : 'idle'}" id="smigStatusText">${fsMsg}</span>
    </div>
    <div class="card-body">
      <div id="smigMsg" class="msg ${fsMigStatus.progress === 'error' ? 'error' : fsMigStatus.progress === 'completed' ? 'success' : 'info'}">${fsMigStatus.message || 'Presiona Ejecutar para copiar los datos de Firestore hacia Supabase.'}</div>
      <div class="bar">
        <div class="bar-fill ${fsMigStatus.progress === 'completed' ? 'completed' : ''} ${fsMigStatus.progress === 'error' ? 'error' : ''}" id="smigBar" style="width:${fsBarWidth}%"></div>
      </div>
    </div>
    <div class="card-actions">
      <button class="btn btn-danger" id="smigBtn" onclick="runSupabaseMigration()" ${fsRunning ? 'disabled' : ''}>
        ${fsRunning ? 'Migrando...' : '▶ Ejecutar Migración'}
      </button>
    </div>
  </div>
</div>

<!-- Modal para páginas -->
<div class="modal-overlay" id="pagesModal">
  <div class="modal">
    <button class="modal-close" onclick="closeModal()" title="Cerrar">✕</button>
    <h2 id="modalTitle">Parámetros</h2>
    <label for="pagesInput" id="modalLabel">Páginas (ej: 1-20 o 1,3,5):</label>
    <input type="text" id="pagesInput" placeholder="1-20" value="1-20">
    <div class="form-hint" id="pagesHint">Usa guión para rangos (1-20) o comas para páginas específicas (1,3,5)</div>
    <label id="idWrap" style="display:none">
      ID del canal:
      <input type="text" id="idInput" placeholder="live_winsportsmas&op=2" style="width:100%;padding:.7rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#fff;font-size:.95rem;margin-bottom:1rem;margin-top:.4rem">
    </label>
    <div id="channelPickWrap" style="display:none;margin-bottom:.4rem">
      <label for="cpChannel">Buscar canal a refrescar:</label>
      <input type="text" id="cpSearch" placeholder="🔍 Buscar canal por nombre, id o grupo..." oninput="cpFilterChannels()" style="width:100%;padding:.7rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#fff;font-size:.95rem;margin-bottom:.5rem">
      <select id="cpChannel" onchange="cpSelectChannel(this)" style="width:100%;padding:.7rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#fff;font-size:.95rem;margin-bottom:.6rem"><option value="">Cargando canales...</option></select>
    </div>
    <label id="jsonWrap" style="display:none">
      Body (JSON, opcional):
      <textarea id="jsonInput" rows="4" placeholder='{"country":"CO","group":"Canales Deportivos","online":true}' style="width:100%;padding:.7rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#fff;font-size:.85rem;margin-bottom:1rem;margin-top:.4rem;font-family:'Courier New',monospace"></textarea>
    </label>
    <label id="replaceWrap">
      <input type="checkbox" id="replaceCheck"> Reemplazar datos existentes
    </label>
    <label id="providerWrap" style="display:none">
      Proveedor a refrescar:
      <select id="providerSelect" style="width:100%;padding:.7rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#fff;font-size:.95rem;margin-bottom:1rem;margin-top:.4rem">
        <option value="vertvcable">vertvcable</option>
        <option value="cablevisionhd">cablevisionhd</option>
        <option value="tvporinternet2">tvporinternet2</option>
        <option value="chatytv">chatytv</option>
        <option value="wsdeportes">wsdeportes</option>
        <option value="senalcolombia">senalcolombia</option>
      </select>
    </label>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="confirmPagesSync()">✅ Ejecutar</button>
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
    </div>
  </div>
</div>

<!-- Modal para Actualizar Canal -->
<div class="modal-overlay" id="ucModal">
  <div class="modal" style="max-width:560px">
    <button class="modal-close" onclick="closeUpdateChannelModal()" title="Cerrar">✕</button>
    <h2>Actualizar Canal</h2>
    <label for="ucChannel">Canal a actualizar:</label>
    <input type="text" id="ucSearch" placeholder="🔍 Buscar canal por nombre, id o grupo..." oninput="ucFilterChannels()">
    <select id="ucChannel"><option value="">Cargando canales...</option></select>
    <div id="ucChannelInfo" class="form-hint" style="display:none"></div>
    <label>Campos a actualizar:</label>
    <div id="ucFields"></div>
    <div class="modal-actions" style="margin-top:.7rem">
      <button class="btn btn-secondary btn-sm" onclick="addChannelFieldRow()">➕ Agregar campo</button>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="ucSaveBtn" onclick="confirmUpdateChannel()">✅ Guardar</button>
      <button class="btn btn-secondary" onclick="closeUpdateChannelModal()">Cancelar</button>
    </div>
  </div>
</div>

<!-- Sección: Agregar Canales (multi-ejecución) -->
<div class="migration-section">
  <h2 style="margin-bottom:1rem;font-size:1.2rem;color:#a0a0c0">📡 Agregar Canales en Vivo</h2>
  <div class="add-channel-card">
    <div class="add-channel-form">
      <div class="form-row">
        <div class="form-group">
          <label>Proveedor</label>
          <select id="chProvider">
            <option value="chatytv">ChatyTV</option>
            <option value="wsdeportes">WsDeportes</option>
            <option value="tvporinternet2">TVporInternet2</option>
            <option value="cablevisionhd">CablevisionHD</option>
            <option value="senalcolombia">Señal Colombia</option>
            <option value="vertvcable">VerTvCable</option>
          </select>
        </div>
        <div class="form-group">
          <label id="chParamLabel">Canal / Slug</label>
          <input type="text" id="chParam" placeholder="ej: caracol">
        </div>
      </div>
      <div class="form-row" id="extraFields">
        <div class="form-group">
          <label>Título</label>
          <input type="text" id="chTitle" placeholder="Nombre del canal">
        </div>
        <div class="form-group">
          <label>Logo URL</label>
          <input type="text" id="chLogo" placeholder="https://...">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>País</label>
          <input type="text" id="chCountry" placeholder="CO" maxlength="2">
        </div>
        <div class="form-group">
          <label>Grupo</label>
          <input type="text" id="chGroup" placeholder="ej: Canales TV" title="Grupo del canal (aparece en la app)">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Opción</label>
          <input type="text" id="chOption" placeholder="opcional" title="Opción numérica para tvporinternet2 / cablevisionhd / vertvcable">
        </div>
      </div>
      <button class="btn btn-primary" onclick="addChannel()">➕ Agregar Canal</button>
      <div style="margin-top:1rem;border-top:1px solid rgba(255,255,255,.1);padding-top:1rem">
        <strong style="color:#a0a0c0;font-size:.9rem">📥 Importar canales desde archivo .m3u</strong>
        <div class="form-row" style="margin-top:.6rem">
          <div class="form-group">
            <label>Archivo .m3u / .m3u8</label>
            <input type="file" id="m3uFile" accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl">
          </div>
          <div class="form-group" style="flex:0 0 auto;display:flex;align-items:flex-end;gap:.5rem">
            <button class="btn btn-primary" onclick="importM3UFile()">⬆️ Importar</button>
          </div>
        </div>
        <div style="margin-top:.4rem;display:flex;align-items:center;gap:.6rem;font-size:.8rem;color:#aaa">
          <label style="display:flex;align-items:center;gap:.4rem;margin:0">
            <input type="checkbox" id="m3uSkipValidation"> Saltar validación (más rápido)
          </label>
        </div>
        <div id="m3uStatus" style="margin-top:.5rem;font-size:.85rem;color:#fbbf24"></div>
      </div>
    </div>
    <div class="add-channel-log" id="chLog">
      <div class="log-empty">Aún no hay ejecuciones</div>
    </div>
    <div style="margin-top:1rem;display:flex;justify-content:space-between;align-items:center">
      <strong style="color:#a0a0c0;font-size:.85rem">📜 Log del servidor (URLs de extracción)</strong>
      <button class="btn btn-secondary btn-sm" onclick="clearAddChannelLog()">🧹 Limpiar</button>
    </div>
    <div class="server-log" id="chServerLog"><div class="log-empty">Sin registros aún</div></div>
  </div>
</div>

<style>
.add-channel-card{background:rgba(255,255,255,.05);border-radius:12px;padding:1.2rem;
  backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);max-width:700px}
.add-channel-form{display:flex;flex-direction:column;gap:.8rem}
.form-row{display:flex;gap:.8rem;flex-wrap:wrap}
.form-group{flex:1;min-width:140px}
.form-group label{display:block;font-size:.8rem;color:#aaa;margin-bottom:.3rem}
.form-group select,.form-group input{width:100%;padding:.55rem;border-radius:6px;border:1px solid rgba(255,255,255,.12);
  background:rgba(255,255,255,.05);color:#fff;font-size:.9rem}
.form-group select option{background:#1e1b4b;color:#fff}
.form-group select:focus,.form-group input:focus{outline:none;border-color:#667eea}
.add-channel-log{margin-top:.8rem;max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:.4rem}
.log-entry{padding:.4rem .6rem;border-radius:6px;font-size:.82rem;display:flex;align-items:center;gap:.5rem}
.log-entry.running{background:rgba(251,191,36,.12);color:#fbbf24}
.log-entry.success{background:rgba(52,211,153,.12);color:#34d399}
.log-entry.error{background:rgba(248,113,113,.12);color:#f87171}
.log-empty{color:#555;font-size:.85rem;text-align:center;padding:.5rem}
.server-log{margin-top:.5rem;background:#0d1117;border-radius:8px;padding:.6rem;max-height:260px;overflow-y:auto;
  font-family:'Courier New',monospace;font-size:.75rem;color:#7ee787;border:1px solid rgba(255,255,255,.08);line-height:1.5}
.server-log .line{padding:1px 0;word-break:break-all}
.server-log .line.e{color:#f87171}
.server-log .line.ok{color:#34d399}
</style>

<script>
// Agregar Canales - multi-ejecución
let channelJobs = [];

document.getElementById('chProvider').addEventListener('change', function() {
  const provider = this.value;
  const label = document.getElementById('chParamLabel');
  const titleField = document.getElementById('chTitle');
  const optionField = document.getElementById('chOption').parentElement;
  if (provider === 'chatytv') {
    label.textContent = 'Canal';
    document.getElementById('chParam').placeholder = 'ej: canal-caracol-tv-en-vivo';
    titleField.required = false;
    optionField.style.display = 'none';
  } else if (provider === 'wsdeportes') {
    label.textContent = 'Parámetro (winsports, etc)';
    document.getElementById('chParam').placeholder = 'ej: winsportsmas&op=2';
    titleField.required = true;
    optionField.style.display = 'none';
  } else if (provider === 'senalcolombia') {
    label.textContent = 'Slug';
    document.getElementById('chParam').placeholder = 'ej: senal-en-vivo';
    titleField.required = true;
    optionField.style.display = 'none';
  } else if (provider === 'vertvcable') {
    label.textContent = 'Slug (URL del canal)';
    document.getElementById('chParam').placeholder = 'ej: mcu-24-7-en-vivo';
    titleField.required = true;
    optionField.style.display = 'block';
  } else {
    label.textContent = 'Slug';
    document.getElementById('chParam').placeholder = 'ej: fox-sports-en-vivo';
    titleField.required = true;
    optionField.style.display = 'block';
  }
});
document.getElementById('chProvider').dispatchEvent(new Event('change'));

async function addChannel() {
  const provider = document.getElementById('chProvider').value;
  const param = document.getElementById('chParam').value.trim();
  const title = document.getElementById('chTitle').value.trim();
  const logo = document.getElementById('chLogo').value.trim();
  const country = document.getElementById('chCountry').value.trim().toUpperCase();
  const group = document.getElementById('chGroup').value.trim();
  const option = document.getElementById('chOption').value.trim();

  if (!param) { alert('Ingresa el parámetro del canal'); return; }
  if ((provider === 'wsdeportes' || provider === 'tvporinternet2' || provider === 'cablevisionhd' || provider === 'senalcolombia' || provider === 'vertvcable') && !title) {
    alert('Ingresa el título del canal'); return;
  }

  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const logEmpty = document.querySelector('.log-empty');
  if (logEmpty) logEmpty.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry running';
  entry.id = 'job_' + id;
  entry.innerHTML = '<span>⏳</span><span><strong>' + provider + '</strong> ' + param + '</span><span style="margin-left:auto">Agregando...</span>';
  document.getElementById('chLog').prepend(entry);

  const route = '/live/channels/add/' + provider + '/' + encodeURIComponent(param);
  const body = {};
  if (title) body.title = title;
  if (logo) body.logo = logo;
  if (country) body.country = country;
  if (group) body.group = group;
  if (option && (provider === 'tvporinternet2' || provider === 'cablevisionhd' || provider === 'vertvcable')) body.option = option;

  try {
    const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (res.ok) {
      entry.className = 'log-entry success';
      entry.innerHTML = '<span>✅</span><span><strong>' + provider + '</strong> ' + param + '</span><span style="margin-left:auto">' + (data.channel?.title || 'Agregado') + '</span>';
    } else {
      entry.className = 'log-entry error';
      entry.innerHTML = '<span>❌</span><span><strong>' + provider + '</strong> ' + param + '</span><span style="margin-left:auto">' + (data.error || 'Error') + '</span>';
    }
  } catch (e) {
    entry.className = 'log-entry error';
    entry.innerHTML = '<span>❌</span><span><strong>' + provider + '</strong> ' + param + '</span><span style="margin-left:auto">Error de red</span>';
  }

  // Limpiar si hay más de 20 entries
  const log = document.getElementById('chLog');
  while (log.children.length > 20) log.removeChild(log.lastChild);
}

document.getElementById('chParam').addEventListener('keydown', function(e) { if (e.key === 'Enter') addChannel(); });

async function importM3UFile() {
  const fileInput = document.getElementById('m3uFile');
  const status = document.getElementById('m3uStatus');
  const file = fileInput.files && fileInput.files[0];
  if (!file) { alert('Selecciona un archivo .m3u'); return; }
  if (file.size > 8 * 1024 * 1024) { alert('El archivo es muy grande (máx 8MB)'); return; }

  status.textContent = 'Leyendo archivo...';
  try {
    const content = await file.text();
    if (!content.includes('#EXTM3U') && !content.includes('#EXTINF')) {
      status.textContent = '❌ El archivo no parece una lista M3U válida';
      return;
    }
    status.textContent = 'Enviando al servidor...';
    const res = await fetch('/sync/live/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: content,
        skipValidation: document.getElementById('m3uSkipValidation').checked,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      status.textContent = '✅ ' + (data.message || 'Import iniciado') + ' — revisa el progreso en "Importar M3U" (sección Sincronizaciones)';
    } else {
      status.textContent = '❌ ' + (data.error || 'Error al importar');
    }
  } catch (e) {
    status.textContent = '❌ Error de red al importar';
  }
}
document.getElementById('m3uFile').addEventListener('change', function() {
  document.getElementById('m3uStatus').textContent = '';
});

// Log del servidor de extracción (urls tomadas por los proveedores)
let addLogPrevLen = 0;
async function refreshAddChannelLog() {
  try {
    const res = await fetch('/sync/detail/addChannel');
    if (!res.ok) return;
    const lines = await res.json();
    const container = document.getElementById('chServerLog');
    const hasNew = lines.length !== addLogPrevLen;
    container.innerHTML = lines.map((line) => {
      const cls = line.includes('❌') ? 'e' : (line.includes('✅') || line.includes('🔒')) ? 'ok' : '';
      const html = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return '<div class="line' + (cls ? ' ' + cls : '') + '">' + html + '</div>';
    }).join('') || '<div class="log-empty">Sin registros aún</div>';
    if (hasNew) container.scrollTop = container.scrollHeight;
    addLogPrevLen = lines.length;
  } catch {}
}
async function clearAddChannelLog() {
  try {
    await fetch('/sync/clear-logs/addChannel', { method: 'POST' });
    document.getElementById('chServerLog').innerHTML = '<div class="log-empty">Sin registros aún</div>';
    addLogPrevLen = 0;
  } catch {}
}
setInterval(refreshAddChannelLog, 2000);
</script>

<script>
let pendingRoute = '';
let pendingKey = '';
let pendingMethod = '';
let pendingParamType = '';

async function runSync(key, route, method, paramType) {
  if (key === 'updateChannel') {
    openUpdateChannelModal();
    return;
  }
  if (paramType === 'pages') {
    openParamsModal(key, route, 'Páginas (ej: 1-20 o 1,3,5):', method, false, false);
    return;
  }
  if (paramType === 'id') {
    openParamsModal(key, route, 'ID del canal:', method, true, false);
    return;
  }
  if (paramType === 'json') {
    openParamsModal(key, route, 'Body JSON:', method, true, true);
    return;
  }
  if (paramType === 'provider') {
    openParamsModal(key, route, 'Proveedor a refrescar:', method, false, false, true);
    return;
  }
  await execSync(route, key, method, {});
}

function openParamsModal(key, route, label, method, needsId, needsJson, needsProvider) {
  pendingKey = key;
  pendingRoute = route;
  pendingMethod = method;
  pendingParamType = needsProvider ? 'provider' : needsJson ? 'json' : needsId ? 'id' : 'pages';
  document.getElementById('modalTitle').textContent = 'Parámetros - ' + key;
  document.getElementById('modalLabel').textContent = label;
  document.getElementById('idWrap').style.display = needsId && needsJson ? 'block' : 'none';
  document.getElementById('channelPickWrap').style.display = needsId && !needsJson ? 'block' : 'none';
  document.getElementById('jsonWrap').style.display = needsJson ? 'block' : 'none';
  document.getElementById('pagesHint').style.display = !needsId && !needsJson && !needsProvider ? 'block' : 'none';
  document.getElementById('pagesInput').style.display = !needsId && !needsJson && !needsProvider ? 'block' : 'none';
  document.getElementById('replaceWrap').style.display = !needsId && !needsJson && !needsProvider ? 'block' : 'none';
  document.getElementById('providerWrap').style.display = needsProvider ? 'block' : 'none';
  document.getElementById('pagesInput').value = '1-20';
  document.getElementById('idInput').value = '';
  document.getElementById('jsonInput').value = '';
  document.getElementById('providerSelect').value = '';
  if (needsId) {
    document.getElementById('cpSearch').value = '';
    document.getElementById('cpSearch').placeholder = '🔍 Buscar canal por nombre, id o grupo...';
    loadChannelPicker();
  }
  document.getElementById('pagesModal').classList.add('active');
}

async function confirmPagesSync() {
  const route = pendingRoute;
  const key = pendingKey;
  const method = pendingMethod;
  const paramType = pendingParamType;
  let body = {};
  let target = route;

  if (paramType === 'provider') {
    const provider = document.getElementById('providerSelect').value.trim();
    if (!provider) {
      alert('Selecciona un proveedor');
      return;
    }
    if (route.includes('{provider}')) {
      target = route.replace('{provider}', encodeURIComponent(provider));
    } else {
      body = { provider };
    }
  } else if (paramType === 'id' || paramType === 'json') {
    const id = (document.getElementById('idInput').value || document.getElementById('cpChannel').value).trim();
    if (!id) {
      alert('Selecciona un canal en la lista de búsqueda');
      return;
    }
    if (route.includes('{id}')) {
      target = route.replace('{id}', encodeURIComponent(id));
    } else {
      body = { id };
    }
    const jsonText = document.getElementById('jsonInput').value.trim();
    if (jsonText) {
      try {
        body = { ...body, ...JSON.parse(jsonText) };
      } catch (e) {
        alert('JSON inválido: ' + e.message);
        return;
      }
    }
  } else {
    const pages = document.getElementById('pagesInput').value.trim();
    const replace = document.getElementById('replaceCheck').checked;
    if (!pages) return;
    body = { pages, replace };
  }

  closeModal();
  await execSync(target, key, method, body);
}

async function execSync(route, key, method, body) {
  const btn = document.querySelector('#card-' + key + ' .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Ejecutando...'; }
  try {
    const res = await fetch(route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.text();
      console.error('Sync error:', err);
      if (btn) { btn.disabled = false; btn.textContent = '▶ Ejecutar'; }
      alert('Error al ejecutar: ' + res.status + ' ' + err.slice(0, 300));
    } else {
      // Immediately poll status to pick up running state
      setTimeout(refreshStatus, 500);
    }
  } catch (e) {
    console.error(e);
    if (btn) { btn.disabled = false; btn.textContent = '▶ Ejecutar'; }
    alert('Error de red: ' + e.message);
  }
}

async function runMigration() {
  const btn = document.querySelector('.migration-card .btn-danger');
  if (btn) { btn.disabled = true; btn.textContent = 'Migrando...'; }
  try {
    const res = await fetch('/sync/migrate-to-firestore', { method: 'POST' });
    if (!res.ok) console.error('Migration error:', await res.text());
  } catch (e) { console.error(e); }
  setTimeout(refreshStatus, 500);
}

async function runSupabaseMigration() {
  const btn = document.getElementById('smigBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Migrando...'; }
  try {
    const res = await fetch('/sync/migrate-firestore-to-supabase', { method: 'POST' });
    if (!res.ok) console.error('Firestore->Supabase migration error:', await res.text());
  } catch (e) { console.error(e); }
  setTimeout(refreshFirestoreMigrationStatus, 500);
}

async function refreshFirestoreMigrationStatus() {
  try {
    const res = await fetch('/sync/firestore-to-supabase-status');
    if (!res.ok) return;
    const s = await res.json();
    const badge = document.getElementById('smigBadge');
    const statusText = document.getElementById('smigStatusText');
    const msg = document.getElementById('smigMsg');
    const bar = document.getElementById('smigBar');
    const btn = document.getElementById('smigBtn');
    if (!statusText || !msg || !bar || !btn) return;
    const map = { idle: '⚪', running: '🟡', completed: '🟢', error: '🔴' };
    const text = s.running ? 'Migrando...' : s.progress === 'completed' ? 'Completado' : s.progress === 'error' ? 'Error' : 'Inactivo';
    if (badge) badge.textContent = map[s.running ? 'running' : s.progress] || '⚪';
    statusText.textContent = text;
    statusText.className = 'status-text ' + (s.running ? 'running' : s.progress === 'completed' ? 'completed' : s.progress === 'error' ? 'failed' : 'idle');
    msg.textContent = s.message || '—';
    msg.className = 'msg ' + (s.progress === 'error' ? 'error' : s.progress === 'completed' ? 'success' : 'info');
    bar.style.width = (s.progress === 'idle' ? 0 : s.progress === 'completed' || s.progress === 'error' ? 100 : 55) + '%';
    bar.className = 'bar-fill ' + (s.progress === 'completed' ? 'completed' : '') + (s.progress === 'error' ? 'error' : '');
    btn.disabled = s.running;
    btn.textContent = s.running ? 'Migrando...' : '▶ Ejecutar Migración';
  } catch {}
}
setInterval(refreshFirestoreMigrationStatus, 3000);

function closeModal() {
  document.getElementById('pagesModal').classList.remove('active');
  pendingRoute = '';
  pendingKey = '';
}

function showParamsModal(key, route, label, method, needsId, needsJson, needsProvider) {
  if (key === 'updateChannel') {
    openUpdateChannelModal();
    return;
  }
  openParamsModal(key, route, 'Parámetros - ' + label, method, needsId === '1', needsJson === '1', needsProvider === '1');
}

// ---------- Actualizar Canal (multi-campo) ----------
let ucChannels = [];

const UC_FIELD_OPTIONS = [
  ['', '— campo —'],
  ['title', 'Título'],
  ['logo', 'Logo'],
  ['group', 'Grupo'],
  ['country', 'País'],
  ['url', 'URL'],
  ['type', 'Tipo'],
  ['online', 'Online (bool)'],
  ['proveedor', 'Proveedor'],
  ['refreshUrl', 'Refresh URL'],
  ['refreshOption', 'Refresh Opción'],
];

function ucFieldRowHtml() {
  const options = UC_FIELD_OPTIONS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
  return '<div class="uc-field-row">' +
    '<select class="uc-field-select" onchange="onFieldChange(this)">' + options + '</select>' +
    '<input type="text" class="uc-field-value" placeholder="Valor">' +
    '<button type="button" class="btn btn-secondary btn-sm" onclick="removeChannelFieldRow(this)">✕</button>' +
  '</div>';
}

function addChannelFieldRow() {
  document.getElementById('ucFields').insertAdjacentHTML('beforeend', ucFieldRowHtml());
}

function removeChannelFieldRow(btn) {
  btn.closest('.uc-field-row').remove();
}

function onFieldChange(sel) {
  const row = sel.closest('.uc-field-row');
  const valWrap = row.querySelector('.uc-field-value');
  if (sel.value === 'online') {
    if (valWrap.tagName === 'SELECT') return;
    const s = document.createElement('select');
    s.className = 'uc-field-value';
    s.innerHTML = '<option value="true">true</option><option value="false">false</option>';
    valWrap.replaceWith(s);
  } else {
    if (valWrap.tagName === 'INPUT') return;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'uc-field-value';
    inp.placeholder = 'Valor';
    valWrap.replaceWith(inp);
  }
}

function showUcChannelInfo() {
  const sel = document.getElementById('ucChannel');
  const ch = ucChannels.find((c) => c.id === sel.value);
  const info = document.getElementById('ucChannelInfo');
  if (ch) {
    info.style.display = 'block';
    info.textContent = 'Grupo: ' + (ch.group || '—') + ' | País: ' + (ch.country || '—') + ' | Proveedor: ' + (ch.proveedor || '—') + ' | Online: ' + (ch.online ? 'sí' : 'no');
  } else {
    info.style.display = 'none';
  }
}

function ucBuildOptions(filter) {
  const sel = document.getElementById('ucChannel');
  sel.innerHTML = '';
  const f = (filter || '').trim().toLowerCase();
  const byGroup = {};
  for (const ch of ucChannels) {
    if (f) {
      const hay = ((ch.title || '') + ' ' + ch.id + ' ' + (ch.group || '')).toLowerCase();
      if (!hay.includes(f)) continue;
    }
    const g = ch.group || 'Sin grupo';
    (byGroup[g] = byGroup[g] || []).push(ch);
  }
  for (const g of Object.keys(byGroup).sort()) {
    const og = document.createElement('optgroup');
    og.label = g + ' (' + byGroup[g].length + ')';
    for (const ch of byGroup[g]) {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = ch.title || ch.id;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  showUcChannelInfo();
}

function ucFilterChannels() {
  ucBuildOptions(document.getElementById('ucSearch').value);
}

let cpChannels = [];

function cpBuildOptions(filter) {
  const sel = document.getElementById('cpChannel');
  sel.innerHTML = '';
  const f = (filter || '').trim().toLowerCase();
  const byGroup = {};
  for (const ch of cpChannels) {
    if (f) {
      const hay = ((ch.title || '') + ' ' + ch.id + ' ' + (ch.group || '')).toLowerCase();
      if (!hay.includes(f)) continue;
    }
    const g = ch.group || 'Sin grupo';
    (byGroup[g] = byGroup[g] || []).push(ch);
  }
  for (const g of Object.keys(byGroup).sort()) {
    const og = document.createElement('optgroup');
    og.label = g + ' (' + byGroup[g].length + ')';
    for (const ch of byGroup[g]) {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = ch.title || ch.id;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
}

function cpFilterChannels() {
  cpBuildOptions(document.getElementById('cpSearch').value);
}

function cpSelectChannel(sel) {
  if (sel.value) {
    document.getElementById('idInput').value = sel.value;
    document.getElementById('cpSearch').value = '';
    document.getElementById('cpSearch').placeholder = '🔍 Buscar canal por nombre, id o grupo...';
  }
}

async function loadChannelPicker() {
  const sel = document.getElementById('cpChannel');
  sel.innerHTML = '<option value="">Cargando canales...</option>';
  sel.disabled = true;
  try {
    const res = await fetch('/live/channels?all=true&limit=1000');
    const data = await res.json();
    cpChannels = data.items || [];
    cpBuildOptions('');
    sel.disabled = false;
  } catch (e) {
    sel.innerHTML = '<option value="">Error cargando canales</option>';
    sel.disabled = false;
  }
}

async function openUpdateChannelModal() {
  document.getElementById('ucFields').innerHTML = '';
  addChannelFieldRow();
  document.getElementById('ucModal').classList.add('active');
  document.getElementById('ucSearch').value = '';

  const sel = document.getElementById('ucChannel');
  sel.innerHTML = '<option value="">Cargando canales...</option>';
  sel.disabled = true;
  try {
    const res = await fetch('/live/channels?all=true&limit=1000');
    const data = await res.json();
    ucChannels = data.items || [];
    ucBuildOptions('');
    sel.disabled = false;
    sel.onchange = showUcChannelInfo;
    showUcChannelInfo();
  } catch (e) {
    sel.innerHTML = '<option value="">Error cargando canales</option>';
    sel.disabled = false;
  }
}

function closeUpdateChannelModal() {
  document.getElementById('ucModal').classList.remove('active');
}

async function confirmUpdateChannel() {
  const id = document.getElementById('ucChannel').value;
  if (!id) { alert('Selecciona un canal'); return; }

  const body = {};
  const rows = document.querySelectorAll('#ucFields .uc-field-row');
  let hasFields = false;
  for (const row of rows) {
    const field = row.querySelector('.uc-field-select').value;
    if (!field) continue;
    let value = row.querySelector('.uc-field-value').value;
    if (field === 'online') value = value === 'true';
    body[field] = value;
    hasFields = true;
  }
  if (!hasFields) { alert('Agrega al menos un campo'); return; }

  const btn = document.getElementById('ucSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  try {
    const res = await fetch('/live/channels/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      alert('✅ Canal actualizado: ' + (data.channel?.title || id));
      closeUpdateChannelModal();
    } else {
      alert('❌ ' + (data.error || 'Error') + (data.allowedFields ? '\\nCampos permitidos: ' + data.allowedFields.join(', ') : ''));
    }
  } catch (e) {
    alert('Error de red');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✅ Guardar'; }
  }
}

// Auto-refresh status + progress cada 3s (en memoria, sin Firestore)
async function refreshStatus() {
  try {
    const res = await fetch('/sync/status');
    if (res.headers.get('content-type')?.includes('application/json')) {
      const data = await res.json();
      for (const key of Object.keys(data)) {
        const s = data[key];
        const card = document.getElementById('card-' + key);
        if (!card) continue;
        const badge = card.querySelector('.badge');
        const statusText = card.querySelector('.status-text');
        const btn = card.querySelector('.btn-primary');
        const progressRow = document.getElementById('prog-' + key);
        const progressMsg = progressRow?.querySelector('.progress-msg');
        const countRow = document.getElementById('row-items-' + key);
        const countVal = countRow?.querySelector('.count-val');
        const map = { idle: '⚪', running: '🟡', completed: '🟢', failed: '🔴' };

        if (badge) badge.textContent = map[s.status] || '⚪';
        if (statusText) { statusText.textContent = s.status; statusText.className = 'status-text ' + s.status; }
        if (btn) { btn.disabled = s.status === 'running'; btn.textContent = s.status === 'running' ? (s.progress ? s.progress.message : 'Ejecutando...') : '▶ Ejecutar'; }

        // Always update count
        if (countVal) {
          countVal.textContent = s.count != null ? s.count : (s.progress ? s.progress.current : 0);
        }

        // Update progress message: always visible when running or completed with count
        if (progressRow && progressMsg) {
          if (s.status === 'running' && s.progress) {
            progressRow.style.display = '';
            progressMsg.textContent = s.progress.message;
          } else if (s.status === 'completed' && s.count != null) {
            progressRow.style.display = '';
            progressMsg.textContent = \`✅ \${s.count} items (en \${s.duration ? (s.duration / 1000).toFixed(1) + 's' : '—'})\`;
          } else if (s.status === 'failed') {
            progressRow.style.display = '';
            progressMsg.textContent = '❌ ' + (s.error || 'Error');
          } else {
            progressRow.style.display = 'none';
          }
        }

        // Show/hide error row
        let errorRow = document.getElementById('row-error-' + key);
        if (s.status === 'failed' && s.error) {
          if (!errorRow) {
            const body = card.querySelector('.card-body');
            const div = document.createElement('div');
            div.className = 'card-row';
            div.id = 'row-error-' + key;
            div.innerHTML = '<span class="label">Error</span><span class="error">' + s.error + '</span>';
            body.insertBefore(div, progressRow);
          } else {
            errorRow.querySelector('.error').textContent = s.error;
          }
        } else if (errorRow && s.status !== 'failed') {
          errorRow.remove();
        }
      }
    }
  } catch {}
}
setInterval(refreshStatus, 3000);

// Refresh automático por proveedor (programador in-app): estado y filas por proveedor
const AR_PROVIDERS = ['wsdeportes', 'cablevisionhd', 'tvporinternet2', 'chatytv', 'senalcolombia', 'vertvcable'];
function arFmtLast(ts) {
  if (!ts) return 'sin ejecutar';
  const d = new Date(ts);
  return 'último: ' + d.toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function arRow(name, minutes, lastRun) {
  return '<div style="display:flex;align-items:center;gap:.8rem;padding:.45rem 0;border-bottom:1px solid rgba(255,255,255,.06)">'
    + '<input type="checkbox" id="arP-' + name + '" ' + (minutes ? 'checked' : '') + ' onchange="saveAutoRefresh()" style="width:18px;height:18px;accent-color:#667eea">'
    + '<label for="arP-' + name + '" style="font-size:.95rem;flex:0 0 160px">' + name + '</label>'
    + '<input type="number" id="arM-' + name + '" min="1" step="1" value="' + (minutes || '') + '" placeholder="min" onchange="saveAutoRefresh()" style="width:80px;padding:.4rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#fff;font-size:.9rem">'
    + '<span style="font-size:.75rem;color:#888">' + arFmtLast(lastRun) + '</span>'
    + '</div>';
}
async function refreshAutoRefreshState(withRows) {
  try {
    const res = await fetch('/sync/auto-refresh');
    const data = await res.json();
    const on = data.enabled === true;
    const toggle = document.getElementById('arToggle');
    const label = document.getElementById('arLabel');
    const badge = document.getElementById('arBadge');
    const statusText = document.getElementById('arStatus');
    toggle.checked = on;
    label.textContent = on ? 'Activado' : 'Pausado';
    badge.textContent = on ? '🟢' : '🔴';
    statusText.textContent = on ? 'activo' : 'pausado';
    statusText.className = 'status-text ' + (on ? 'completed' : 'failed');
    const provs = data.providers || {};
    const lastRuns = data.providerLastRuns || {};
    const hint = document.getElementById('arHint');
    if (hint) {
      const active = Object.keys(provs).length;
      hint.textContent = on
        ? (active ? active + ' proveedor(es) con refresh automático' : 'Ningún proveedor configurado aún (marca uno y pon los minutos)')
        : 'Pausado por el dashboard';
    }
    // Las filas SOLO se reconstruyen al pulsar "Consultar estado" (withRows=true)
    // y nunca si el usuario está escribiendo en un input, para no borrar lo tecleado.
    if (withRows) {
      const activeEl = document.activeElement;
      const typing = activeEl && activeEl.id && (activeEl.id.indexOf('arP-') === 0 || activeEl.id.indexOf('arM-') === 0);
      if (!typing) {
        const rows = document.getElementById('arRows');
        if (rows) {
          rows.innerHTML = AR_PROVIDERS.map(function (name) {
            return arRow(name, provs[name], lastRuns[name]);
          }).join('');
        }
      }
    }
  } catch {}
}
async function saveAutoRefresh() {
  const enabled = document.getElementById('arToggle').checked;
  const providers = {};
  AR_PROVIDERS.forEach(function (name) {
    const cb = document.getElementById('arP-' + name);
    if (cb && cb.checked) {
      const v = parseInt(document.getElementById('arM-' + name).value, 10);
      if (Number.isFinite(v) && v >= 1) providers[name] = v;
    }
  });
  try {
    const res = await fetch('/sync/auto-refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, providers }),
    });
    await res.json();
  } catch {}
  refreshAutoRefreshState(false);
}

// ── Tarjetas: ordenar / ocultar (persistido en localStorage) ──
const CARD_LAYOUT_KEY = 'veamos.syncCards';
let cardLayout = null;
let dragKey = null;
function loadCardLayout() {
  try {
    const raw = localStorage.getItem(CARD_LAYOUT_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    cardLayout = {
      order: Array.isArray(parsed.order) ? parsed.order : [],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
    };
  } catch {
    cardLayout = { order: [], hidden: [] };
  }
}
function saveCardLayout() {
  try { localStorage.setItem(CARD_LAYOUT_KEY, JSON.stringify(cardLayout)); } catch {}
}
function applyCardLayout() {
  const grid = document.getElementById('dashboard');
  if (!grid) return;
  const wraps = Array.prototype.slice.call(grid.children);
  const order = cardLayout.order.filter(function (k) {
    return wraps.some(function (w) { return w.id === 'wrap-' + k; });
  });
  const rest = wraps.filter(function (w) { return order.indexOf(w.id.replace('wrap-', '')) === -1; });
  order.forEach(function (k) {
    const w = document.getElementById('wrap-' + k);
    if (w) grid.appendChild(w);
  });
  rest.forEach(function (w) { grid.appendChild(w); });
  wraps.forEach(function (w) {
    const key = w.id.replace('wrap-', '');
    const hidden = cardLayout.hidden.indexOf(key) !== -1;
    w.classList.toggle('card-hidden', hidden);
    const btn = document.getElementById('hidebtn-' + key);
    if (btn) {
      btn.textContent = hidden ? '👁' : '🚫';
      btn.title = hidden ? 'Mostrar tarjeta' : 'Ocultar tarjeta';
    }
  });
  updateHiddenBar();
}
function toggleCardHide(key) {
  const i = cardLayout.hidden.indexOf(key);
  if (i === -1) cardLayout.hidden.push(key); else cardLayout.hidden.splice(i, 1);
  saveCardLayout();
  applyCardLayout();
}
function unhideAllCards() {
  cardLayout.hidden = [];
  saveCardLayout();
  applyCardLayout();
}
function updateHiddenBar() {
  const bar = document.getElementById('hiddenBar');
  if (!bar) return;
  const hidden = cardLayout.hidden.filter(function (k) { return document.getElementById('wrap-' + k); });
  if (hidden.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const list = document.getElementById('hiddenList');
  list.innerHTML = hidden.map(function (k) {
    const wrap = document.getElementById('wrap-' + k);
    const titleEl = wrap ? wrap.querySelector('.card-title') : null;
    const label = titleEl && titleEl.textContent ? titleEl.textContent : k;
    return '<a onclick="toggleCardHide(' + k + ')" title="Restaurar">' + label + '</a>';
  }).join('');
}
document.addEventListener('dragstart', function (e) {
  const t = e.target;
  if (t && t.classList && t.classList.contains('drag-handle')) {
    const wrap = t.closest('.card-wrap');
    if (!wrap) return;
    dragKey = wrap.id.replace('wrap-', '');
    e.dataTransfer.setData('text/plain', dragKey);
    e.dataTransfer.effectAllowed = 'move';
    wrap.classList.add('dragging');
  }
});
document.addEventListener('dragend', function () {
  document.querySelectorAll('.card-wrap').forEach(function (w) {
    w.classList.remove('dragging', 'drag-over');
  });
  dragKey = null;
});
document.addEventListener('dragover', function (e) {
  const w = e.target && e.target.closest ? e.target.closest('.card-wrap') : null;
  if (w && dragKey && w.id !== 'wrap-' + dragKey) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    w.classList.add('drag-over');
  }
});
document.addEventListener('dragleave', function (e) {
  const w = e.target && e.target.closest ? e.target.closest('.card-wrap') : null;
  if (w) w.classList.remove('drag-over');
});
document.addEventListener('drop', function (e) {
  e.preventDefault();
  const w = e.target && e.target.closest ? e.target.closest('.card-wrap') : null;
  if (!w || !dragKey || w.id === 'wrap-' + dragKey) return;
  const grid = document.getElementById('dashboard');
  const order = Array.prototype.slice.call(grid.children).map(function (c) {
    return c.id.replace('wrap-', '');
  });
  const from = order.indexOf(dragKey);
  const to = order.indexOf(w.id.replace('wrap-', ''));
  if (from === -1 || to === -1) return;
  order.splice(from, 1);
  order.splice(to, 0, dragKey);
  cardLayout.order = order;
  saveCardLayout();
  applyCardLayout();
});
loadCardLayout();
applyCardLayout();
</script>
</body>
</html>`;
}

/* ───── Migración de JSON local a Firestore ───── */

function generateMigrationPage(status: MigrationStatus): string {
  const isRunning = status.running;
  const progressMap: Record<string, string> = {
    idle: '⏳ Inactivo',
    reading: '📖 Leyendo archivo...',
    writing: '💾 Escribiendo en Firestore...',
    completed: '✅ Completado',
    error: '❌ Error',
  };

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Migración a Firestore</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:#0f0c29;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.container{background:rgba(255,255,255,.05);border-radius:16px;padding:2rem;width:90%;max-width:600px;
  backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1)}
h1{font-size:1.5rem;margin-bottom:1.5rem;background:linear-gradient(135deg,#667eea,#764ba2);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.status-row{display:flex;justify-content:space-between;padding:.6rem 0;border-bottom:1px solid rgba(255,255,255,.05)}
.label{color:#888}
.value{font-weight:600}
.value.running{color:#fbbf24}
.value.completed{color:#34d399}
.value.error{color:#f87171}
.bar{height:8px;background:rgba(255,255,255,.1);border-radius:4px;margin-top:1rem;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .5s;background:linear-gradient(90deg,#667eea,#764ba2)}
.bar-fill.completed{background:linear-gradient(90deg,#34d399,#059669)}
.bar-fill.error{background:linear-gradient(90deg,#f87171,#dc2626)}
.btn{display:inline-block;padding:.7rem 1.5rem;border-radius:8px;text-decoration:none;
  font-weight:600;margin-top:1.5rem;cursor:pointer;border:none;font-size:.9rem}
.btn-primary{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
.btn-primary:hover{opacity:.9}
.btn:disabled{opacity:.5;cursor:not-allowed}
.msg{margin-top:1rem;padding:.7rem;border-radius:8px;font-size:.9rem}
.msg.info{background:rgba(96,165,250,.15);color:#93c5fd}
.msg.error{background:rgba(248,113,113,.15);color:#fca5a5}
.msg.success{background:rgba(52,211,153,.15);color:#6ee7b7}
</style>
</head>
<body>
<div class="container">
<h1>🚀 Migración a Firestore</h1>

<div class="status-row"><span class="label">Estado</span>
  <span class="value ${status.progress}">${progressMap[status.progress] || status.progress}</span></div>
<div class="status-row"><span class="label">Mensaje</span><span class="value">${status.message || '—'}</span></div>
<div class="status-row"><span class="label">Películas</span><span class="value">${status.stats.movies}</span></div>
<div class="status-row"><span class="label">Series</span><span class="value">${status.stats.series}</span></div>
<div class="status-row"><span class="label">Canales</span><span class="value">${status.stats.channels}</span></div>
<div class="status-row"><span class="label">Populares (M)</span><span class="value">${status.stats.popularMovies}</span></div>
<div class="status-row"><span class="label">Populares (S)</span><span class="value">${status.stats.popularSeries}</span></div>
<div class="status-row"><span class="label">Estrenos (M)</span><span class="value">${status.stats.estrenoMovies}</span></div>
<div class="status-row"><span class="label">Estrenos (S)</span><span class="value">${status.stats.estrenoSeries}</span></div>

<div class="bar">
  <div class="bar-fill ${status.progress === 'completed' ? 'completed' : ''} ${status.progress === 'error' ? 'error' : ''}"
       style="width:${status.progress === 'idle' ? 0 : status.progress === 'completed' || status.progress === 'error' ? 100 : status.progress === 'writing' ? 80 : 30}%"></div>
</div>

${status.message ? `<div class="msg ${status.progress === 'error' ? 'error' : status.progress === 'completed' ? 'success' : 'info'}">${status.message}</div>` : ''}

<div style="display:flex;gap:1rem;margin-top:1.5rem">
  <form action="/sync/migrate-to-firestore" method="POST">
    <button class="btn btn-primary" type="submit" ${isRunning ? 'disabled' : ''}>
      ${isRunning ? 'Migrando...' : 'Iniciar Migración'}
    </button>
  </form>
  <a href="/sync/migration-status" class="btn btn-primary" style="text-align:center">↻ Recargar</a>
</div>
</div>

<script>
async function poll() {
  try {
    const res = await fetch('/sync/migration-status');
    if (res.headers.get('content-type')?.includes('application/json')) {
      const data = await res.json();
      const progressMap = { idle: '⏳ Inactivo', reading: '📖 Leyendo archivo...', writing: '💾 Escribiendo en Firestore...', completed: '✅ Completado', error: '❌ Error' };
      document.querySelectorAll('.status-row .value')[0].textContent = progressMap[data.progress] || data.progress;
      document.querySelectorAll('.status-row .value')[1].textContent = data.message || '—';
      document.querySelectorAll('.status-row .value')[2].textContent = data.stats.movies;
      document.querySelectorAll('.status-row .value')[3].textContent = data.stats.series;
      document.querySelectorAll('.status-row .value')[4].textContent = data.stats.channels;
      document.querySelectorAll('.status-row .value')[5].textContent = data.stats.popularMovies;
      document.querySelectorAll('.status-row .value')[6].textContent = data.stats.popularSeries;
      document.querySelectorAll('.status-row .value')[7].textContent = data.stats.estrenoMovies;
      document.querySelectorAll('.status-row .value')[8].textContent = data.stats.estrenoSeries;
      document.querySelector('.btn-primary').disabled = data.running;
      document.querySelector('.btn-primary').textContent = data.running ? 'Migrando...' : 'Iniciar Migración';
    }
    if (!res.ok) return;
  } catch {}
}
setInterval(poll, 2000);
</script>
</body>
</html>`;
}

export async function migrateToFirestoreHandler(_request: FastifyRequest, reply: FastifyReply) {
  if (migrationStatus.running) {
    return reply.status(409).send({ error: 'Migration already in progress' });
  }

  migrationStatus.running = true;
  migrationStatus.progress = 'reading';
  migrationStatus.message = 'Leyendo sync-data.json...';
  migrationStatus.error = null;
  migrationStatus.stats = { movies: 0, series: 0, channels: 0, popularMovies: 0, popularSeries: 0, estrenoMovies: 0, estrenoSeries: 0 };
  migrationStatus.updatedAt = Date.now();

  runMigration().catch((err) => {
    migrationStatus.running = false;
    migrationStatus.progress = 'error';
    migrationStatus.message = err.message;
    migrationStatus.error = err.message;
    migrationStatus.updatedAt = Date.now();
    logger.error({ error: err }, 'Migration to Firestore failed');
  });

  return reply.send({ ok: true, message: 'Migration started' });
}

async function runMigration(): Promise<void> {
  const filePath = path.join(process.cwd(), 'data', 'sync-data.json');

  if (!fs.existsSync(filePath)) {
    throw new Error(`Archivo no encontrado: ${filePath}`);
  }

  migrationStatus.message = `Archivo encontrado, leyendo...`;
  migrationStatus.updatedAt = Date.now();

  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);

  const stats = {
    movies: data.movies?.length || 0,
    series: data.series?.length || 0,
    channels: data.channels?.length || 0,
    popularMovies: data.popularMovies?.length || 0,
    popularSeries: data.popularSeries?.length || 0,
    estrenoMovies: data.estrenoMovies?.length || 0,
    estrenoSeries: data.estrenoSeries?.length || 0,
  };

  migrationStatus.stats = stats;
  migrationStatus.progress = 'writing';
  migrationStatus.message = `Subiendo ${stats.movies} películas, ${stats.series} series, ${stats.channels} canales a Firestore...`;
  migrationStatus.updatedAt = Date.now();

  await saveSyncData({
    movies: data.movies || [],
    series: data.series || [],
    channels: data.channels || [],
    popularMovies: data.popularMovies || [],
    popularSeries: data.popularSeries || [],
    estrenoMovies: data.estrenoMovies || [],
    estrenoSeries: data.estrenoSeries || [],
    updatedAt: Date.now(),
  });

  migrationStatus.running = false;
  migrationStatus.progress = 'completed';
  migrationStatus.message = 'Migración completada exitosamente';
  migrationStatus.updatedAt = Date.now();
  logger.info({ stats }, 'Migration to Firestore completed');
}

export async function migrationStatusHandler(request: FastifyRequest, reply: FastifyReply) {
  const accept = request.headers.accept || '';
  if (accept.includes('text/html')) {
    return reply.type('text/html').send(generateMigrationPage(migrationStatus));
  }
  return reply.send(migrationStatus);
}

/* ───── Migración de Firestore a Supabase (dashboard) ───── */

export async function runFirestoreToSupabaseHandler(_request: FastifyRequest, reply: FastifyReply) {
  const status = getFirestoreMigrationStatus();
  if (status.running) {
    return reply.status(409).send({ error: 'Migration already in progress' });
  }

  status.running = true;
  status.progress = 'reading';
  status.message = 'Iniciando migración Firestore -> Supabase...';
  status.error = null;
  status.updatedAt = Date.now();

  runFirestoreToSupabase().catch((err) => {
    status.running = false;
    status.progress = 'error';
    status.message = err.message;
    status.error = err.message;
    status.updatedAt = Date.now();
    logger.error({ error: err }, 'Firestore -> Supabase migration failed');
  });

  return reply.send({ ok: true, message: 'Migration started' });
}

export async function firestoreToSupabaseStatusHandler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.send(getFirestoreMigrationStatus());
}
