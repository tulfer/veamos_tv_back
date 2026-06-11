import fs from 'fs';
import path from 'path';
import { FastifyRequest, FastifyReply } from 'fastify';
import { scrapeMovies, scrapeMovieDetail, scrapePopularMovies } from '../../providers/movies';
import { scrapeSeries, scrapeSeriesDetail, scrapePopularSeries } from '../../providers/series';
import { saveSyncData, loadSyncData, saveHomeData, loadHomeData } from '../../services/data-store';
import { fetchItemDetails } from '../../providers/cineby';
import { closeBrowser } from '../../services/video-resolver';
import { fetchLiveChannels, parseM3U, validateBatch } from '../../providers/live-tv';
import { fetchHTML } from '../../utils/http';
import { logger } from '../../utils/logger';
import { memoryCache } from '../../cache/memory';
import { SyncMovie, SyncSeries, SyncData, LiveChannel } from '../../types';
import { startSync, completeSync, failSync, SyncType } from '../../services/sync-status';

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

async function syncMovies(pages: number[]): Promise<SyncMovie[]> {
  const allItems: { id: string; title: string; poster?: string; rating?: number; year?: number }[] = [];

  for (const page of pages) {
    const pageData = await scrapeMovies(page);
    for (const item of pageData.items) {
      allItems.push({ id: item.id, title: item.title, poster: item.poster, rating: item.rating, year: item.year });
    }
    logger.info({ page, total: allItems.length }, 'Movies list page synced');
  }

  const results: SyncMovie[] = [];

  await processBatch(allItems, async (item) => {
    try {
      const detail = await scrapeMovieDetail(item.id);
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

  return results;
}

async function syncSeries(pages: number[]): Promise<SyncSeries[]> {
  const allItems: { id: string; title: string; poster?: string; rating?: number; year?: number }[] = [];

  for (const page of pages) {
    const pageData = await scrapeSeries(page);
    for (const item of pageData.items) {
      allItems.push({ id: item.id, title: item.title, poster: item.poster, rating: item.rating, year: item.year });
    }
    logger.info({ page, total: allItems.length }, 'Series list page synced');
  }

  const results: SyncSeries[] = [];

  await processBatch(allItems, async (item) => {
    try {
      const detail = await scrapeSeriesDetail(item.id);
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
    const movies = await syncMovies(pages);
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
    const series = await syncSeries(pages);
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
      const migrated = await migrateChannelsFromJson();
      if (migrated > 0) {
        logger.info({ migrated }, 'Channels migrated from JSON');
        return migrated;
      }
    }

    const channels = await fetchLiveChannels();
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
    const popularMovies = await scrapePopularMovies();
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
    const popularSeries = await scrapePopularSeries();
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
    const { scrapeCinebyHome, saveCinebyHomeData } = await import('../../providers/cineby');
    const data = await scrapeCinebyHome();
    await saveCinebyHomeData(data);
    return Object.keys(data.sections || {}).length || data.banner?.length || 0;
  });
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
    const homeData = await loadHomeData<any>();
    if (!homeData) {
      return reply.status(404).send({ error: 'Home data not found. Run /sync/home-bysc first.' });
    }

    const allItems: { id: number; mediaType: string; slug: string; title: string }[] = [];
    collectItems(homeData, allItems);

    const details = await fetchItemDetails(allItems);
    const detailMap = new Map(details.map(d => [d.id, d]));
    enrichItem(homeData, detailMap);

    await saveHomeData(homeData);

    return reply.send({
      ok: true,
      enriched: details.length,
      updatedAt: Date.now(),
    });
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
  if (!startSync('channels')) {
    return reply.send({ ok: true, message: 'Import already in progress' });
  }

  reply.send({ ok: true, message: 'M3U import started' });

  runBackgroundSync('channels', async () => {
    let rawContent: string;
    const sourceCountry: string | undefined = body.country;

    if (body.url) {
      rawContent = await fetchHTML(body.url);
    } else {
      rawContent = body.content!;
    }

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

    const toAdd = body.skipValidation ? channels : await validateBatchBatched(channels);
    if (toAdd.length === 0) {
      logger.info('No valid channels found in M3U data');
      return 0;
    }

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

    logger.info({ imported: newChannels.length, skipped }, 'M3U import completed');
    return newChannels.length;
  });
}

export async function syncStatusHandler(_request: FastifyRequest, reply: FastifyReply) {
  const { getSyncStatus } = await import('../../services/sync-status');
  return reply.send(getSyncStatus());
}
