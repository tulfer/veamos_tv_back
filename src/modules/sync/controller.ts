import { FastifyRequest, FastifyReply } from 'fastify';
import { scrapeMovies, scrapeMovieDetail, scrapePopularMovies } from '../../providers/movies';
import { scrapeSeries, scrapeSeriesDetail, scrapePopularSeries } from '../../providers/series';
import { saveSyncData, loadSyncData } from '../../services/data-store';
import { closeBrowser } from '../../services/video-resolver';
import { fetchLiveChannels, parseM3U, validateBatch } from '../../providers/live-tv';
import { fetchHTML } from '../../utils/http';
import { logger } from '../../utils/logger';
import { memoryCache } from '../../cache/memory';
import { SyncMovie, SyncSeries, SyncData, LiveChannel } from '../../types';

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

export async function syncMoviesHandler(request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  const body = request.body as { pages?: string; replace?: boolean } | undefined;
  const pages = parsePages(body?.pages);
  if (pages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  logger.info({ pages }, 'Starting movie sync');

  try {
    const movies = await syncMovies(pages);
    const existing = loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalMovies = shouldReplace ? movies : mergeByIdGeneric(movies, existing?.movies || []);
    saveSyncData({
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
    return reply.send({ ok: true, movies: finalMovies.length, series: existing?.series.length || 0, replaced: shouldReplace });
  } catch (error) {
    logger.error({ error }, 'Movie sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncSeriesHandler(request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  const body = request.body as { pages?: string; replace?: boolean } | undefined;
  const pages = parsePages(body?.pages);
  if (pages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  logger.info({ pages }, 'Starting series sync');

  try {
    const series = await syncSeries(pages);
    const existing = loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalSeries = shouldReplace ? series : mergeByIdGeneric(series, existing?.series || []);
    saveSyncData({
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
    return reply.send({ ok: true, movies: existing?.movies.length || 0, series: finalSeries.length, replaced: shouldReplace });
  } catch (error) {
    logger.error({ error }, 'Series sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncAllHandler(request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  const body = request.body as { pages?: string; movies?: string; series?: string; replace?: boolean } | undefined;
  const moviePages = parsePages(body?.movies ?? body?.pages);
  const seriesPages = parsePages(body?.series ?? body?.pages);
  if (moviePages.length === 0 && seriesPages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  logger.info({ moviePages, seriesPages }, 'Starting full sync');

  try {
    const [movies, series] = await Promise.all([
      moviePages.length > 0 ? syncMovies(moviePages) : Promise.resolve([]),
      seriesPages.length > 0 ? syncSeries(seriesPages) : Promise.resolve([]),
    ]);
    const existing = loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalMovies = shouldReplace ? movies : mergeByIdGeneric(movies, existing?.movies || []);
    const finalSeries = shouldReplace ? series : mergeByIdGeneric(series, existing?.series || []);
    saveSyncData({
      movies: finalMovies,
      series: finalSeries,
      channels: existing?.channels || [],
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    await closeBrowser();
    return reply.send({ ok: true, movies: finalMovies.length, series: finalSeries.length, replaced: shouldReplace });
  } catch (error) {
    logger.error({ error }, 'Full sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncEstrenoMoviesHandler(request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  const body = request.body as { pages?: string; replace?: boolean } | undefined;
  const pages = parsePages(body?.pages);
  if (pages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  logger.info({ pages }, 'Starting estreno movies sync');

  try {
    const movies = await syncMovies(pages);
    const existing = loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalEstrenoMovies = shouldReplace ? movies : mergeByIdGeneric(movies, existing?.estrenoMovies || []);
    saveSyncData({
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
    return reply.send({ ok: true, estrenoMovies: finalEstrenoMovies.length, replaced: shouldReplace });
  } catch (error) {
    logger.error({ error }, 'Estreno movies sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncEstrenoSeriesHandler(request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  const body = request.body as { pages?: string; replace?: boolean } | undefined;
  const pages = parsePages(body?.pages);
  if (pages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  logger.info({ pages }, 'Starting estreno series sync');

  try {
    const series = await syncSeries(pages);
    const existing = loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalEstrenoSeries = shouldReplace ? series : mergeByIdGeneric(series, existing?.estrenoSeries || []);
    saveSyncData({
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
    return reply.send({ ok: true, estrenoSeries: finalEstrenoSeries.length, replaced: shouldReplace });
  } catch (error) {
    logger.error({ error }, 'Estreno series sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncLiveHandler(request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  const body = request.body as { replace?: boolean } | undefined;
  logger.info('Starting live channels sync');

  try {
    const channels = await fetchLiveChannels();
    const existing = loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalChannels = shouldReplace ? channels : mergeChannels(channels, existing?.channels || []);
    saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: finalChannels,
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    return reply.send({ ok: true, channels: finalChannels.length, replaced: shouldReplace });
  } catch (error) {
    logger.error({ error }, 'Live channels sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncPopularMoviesHandler(request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  const body = request.body as { replace?: boolean } | undefined;
  logger.info('Starting popular movies sync');

  try {
    const popularMovies = await scrapePopularMovies();
    const existing = loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalPopularMovies = shouldReplace ? popularMovies : mergeByIdGeneric(popularMovies, existing?.popularMovies || []);
    saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: existing?.channels || [],
      popularMovies: finalPopularMovies,
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    return reply.send({ ok: true, popularMovies: finalPopularMovies.length, replaced: shouldReplace });
  } catch (error) {
    logger.error({ error }, 'Popular movies sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncPopularSeriesHandler(request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  const body = request.body as { replace?: boolean } | undefined;
  logger.info('Starting popular series sync');

  try {
    const popularSeries = await scrapePopularSeries();
    const existing = loadSyncData();
    const shouldReplace = body?.replace === true;
    const finalPopularSeries = shouldReplace ? popularSeries : mergeByIdGeneric(popularSeries, existing?.popularSeries || []);
    saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: existing?.channels || [],
      popularMovies: existing?.popularMovies || [],
      popularSeries: finalPopularSeries,
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    return reply.send({ ok: true, popularSeries: finalPopularSeries.length, replaced: shouldReplace });
  } catch (error) {
    logger.error({ error }, 'Popular series sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
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

export async function importM3UHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { url?: string; content?: string; country?: string; skipValidation?: boolean } | undefined;
  if (!body?.url && !body?.content) {
    return reply.status(400).send({ error: 'Provide "url" or "content" with .m3u data' });
  }

  try {
    let rawContent: string;
    const sourceCountry: string | undefined = body.country;

    if (body.url) {
      rawContent = await fetchHTML(body.url);
    } else {
      rawContent = body.content!;
    }

    const parsed = parseM3U(rawContent, sourceCountry);
    if (parsed.length === 0) {
      return reply.status(400).send({ error: 'No channels found in the provided .m3u data' });
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
      return reply.send({ ok: true, imported: 0, skipped: 0, message: 'No valid channels found in the provided list' });
    }

    const existing = loadSyncData();
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

    saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: [...existingChannels, ...newChannels],
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });

    return reply.send({ ok: true, imported: newChannels.length, skipped, total: existingChannels.length + newChannels.length });
  } catch (error) {
    logger.error({ error }, 'M3U import failed');
    return reply.status(500).send({ error: 'Import failed' });
  }
}
