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
  const body = request.body as { pages?: string } | undefined;
  const pages = parsePages(body?.pages);
  if (pages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  logger.info({ pages }, 'Starting movie sync');

  try {
    const movies = await syncMovies(pages);
    const existing = loadSyncData();
    saveSyncData({
      movies,
      series: existing?.series || [],
      channels: existing?.channels || [],
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      updatedAt: Date.now(),
    });
    await closeBrowser();
    return reply.send({ ok: true, movies: movies.length, series: existing?.series.length || 0 });
  } catch (error) {
    logger.error({ error }, 'Movie sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncSeriesHandler(request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  const body = request.body as { pages?: string } | undefined;
  const pages = parsePages(body?.pages);
  if (pages.length === 0) {
    return reply.status(400).send({ error: 'Provide pages in body, e.g. { "pages": "1-20" }' });
  }
  logger.info({ pages }, 'Starting series sync');

  try {
    const series = await syncSeries(pages);
    const existing = loadSyncData();
    saveSyncData({
      movies: existing?.movies || [],
      series,
      channels: existing?.channels || [],
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      updatedAt: Date.now(),
    });
    await closeBrowser();
    return reply.send({ ok: true, movies: existing?.movies.length || 0, series: series.length });
  } catch (error) {
    logger.error({ error }, 'Series sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncAllHandler(request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  const body = request.body as { pages?: string; movies?: string; series?: string } | undefined;
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
    saveSyncData({
      movies,
      series,
      channels: existing?.channels || [],
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      updatedAt: Date.now(),
    });
    await closeBrowser();
    return reply.send({ ok: true, movies: movies.length, series: series.length });
  } catch (error) {
    logger.error({ error }, 'Full sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncLiveHandler(_request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  logger.info('Starting live channels sync');

  try {
    const channels = await fetchLiveChannels();
    const existing = loadSyncData();
    saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels,
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      updatedAt: Date.now(),
    });
    return reply.send({ ok: true, channels: channels.length });
  } catch (error) {
    logger.error({ error }, 'Live channels sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncPopularMoviesHandler(_request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  logger.info('Starting popular movies sync');

  try {
    const popularMovies = await scrapePopularMovies();
    const existing = loadSyncData();
    saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: existing?.channels || [],
      popularMovies,
      popularSeries: existing?.popularSeries || [],
      updatedAt: Date.now(),
    });
    return reply.send({ ok: true, popularMovies: popularMovies.length });
  } catch (error) {
    logger.error({ error }, 'Popular movies sync failed');
    return reply.status(500).send({ error: 'Sync failed' });
  }
}

export async function syncPopularSeriesHandler(_request: FastifyRequest, reply: FastifyReply) {
  memoryCache.flush();
  logger.info('Starting popular series sync');

  try {
    const popularSeries = await scrapePopularSeries();
    const existing = loadSyncData();
    saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels: existing?.channels || [],
      popularMovies: existing?.popularMovies || [],
      popularSeries,
      updatedAt: Date.now(),
    });
    return reply.send({ ok: true, popularSeries: popularSeries.length });
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
    let sourceCountry: string | undefined = body.country;

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
      updatedAt: Date.now(),
    });

    return reply.send({ ok: true, imported: newChannels.length, skipped, total: existingChannels.length + newChannels.length });
  } catch (error) {
    logger.error({ error }, 'M3U import failed');
    return reply.status(500).send({ error: 'Import failed' });
  }
}
