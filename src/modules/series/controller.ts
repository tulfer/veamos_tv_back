import { FastifyRequest, FastifyReply } from 'fastify';
import { scrapeSeries, scrapeSeriesDetail } from '../../providers/series';
import { getCachedOrFetch } from '../../cache';
import { loadSyncData } from '../../services/data-store';
import { SyncSeries, MediaItem } from '../../types';

const PAGE_SIZE = 24;

function getFromSync(): SyncSeries[] | null {
  const data = loadSyncData();
  return data?.series || null;
}

export async function getSeriesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { page = '1' } = request.query as any;
  const pageNum = parseInt(page) || 1;

  const synced = getFromSync();
  if (synced) {
    const totalPages = Math.ceil(synced.length / PAGE_SIZE) || 1;
    const start = (pageNum - 1) * PAGE_SIZE;
    const items: MediaItem[] = synced.slice(start, start + PAGE_SIZE).map((s) => ({
      id: s.id,
      title: s.title,
      poster: s.poster,
      rating: s.rating,
      year: s.year,
      type: 'series' as const,
    }));

    return reply.send({ page: pageNum, totalPages, total: items.length, items });
  }

  const result = await getCachedOrFetch(
    `series:page:${pageNum}`,
    () => scrapeSeries(pageNum),
    600,
  );

  return reply.send({
    page: pageNum,
    totalPages: result.totalPages,
    total: result.items.length,
    items: result.items,
  });
}

export async function getSeriesDetailHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as any;

  const synced = getFromSync();
  if (synced) {
    const series = synced.find((s) => s.id === id);
    if (series) {
      return reply.send({
        id: series.id,
        title: series.title,
        description: series.description || `${series.title} disponible en Veamos TV.`,
        poster: series.poster,
        backdrop: series.backdrop || series.poster,
        rating: series.rating || 8.0,
        year: series.year || 2024,
        genres: series.genres || ['Drama', 'Action'],
        cast: series.cast || [{ name: 'Reparto Principal' }],
        type: 'series' as const,
        seasons: series.seasons,
        videos: series.videos,
      });
    }
    return reply.status(404).send({ error: 'Series not found' });
  }

  const detail = await getCachedOrFetch(
    `series:detail:${id}`,
    () => scrapeSeriesDetail(id)!,
    600,
  );

  if (!detail) {
    return reply.status(404).send({ error: 'Series not found' });
  }

  return reply.send(detail);
}

export async function getSeasonEpisodesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id, seasonNumber } = request.params as any;

  const synced = getFromSync();
  if (synced) {
    const series = synced.find((s) => s.id === id);
    if (!series) return reply.status(404).send({ error: 'Series not found' });
    const season = series.seasons?.find((s) => s.season_number === parseInt(seasonNumber));
    if (!season) return reply.status(404).send({ error: 'Season not found' });
    return reply.send(season);
  }

  const detail = await getCachedOrFetch(
    `series:detail:${id}`,
    () => scrapeSeriesDetail(id)!,
    600,
  );

  if (!detail) return reply.status(404).send({ error: 'Series not found' });

  const season = detail.seasons?.find(
    (s) => s.season_number === parseInt(seasonNumber),
  );

  if (!season) return reply.status(404).send({ error: 'Season not found' });

  return reply.send(season);
}
