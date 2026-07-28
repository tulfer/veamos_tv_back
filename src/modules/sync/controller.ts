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
