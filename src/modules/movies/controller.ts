import { FastifyRequest, FastifyReply } from 'fastify';
import { scrapeMovies, scrapeMovieDetail } from '../../providers/movies';
import { getCachedOrFetch } from '../../cache';
import { loadSyncData } from '../../services/data-store';
import { SyncMovie, MediaItem } from '../../types';

const PAGE_SIZE = 24;

async function getFromSync(): Promise<SyncMovie[] | null> {
  const data = await loadSyncData();
  return data?.movies || null;
}

export async function getMoviesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { page = '1' } = request.query as any;
  const pageNum = parseInt(page) || 1;

  const synced = await getFromSync();
  if (synced) {
    const data = await loadSyncData();
    const estrenos = data?.estrenoMovies || [];
    const estrenoIds = new Set(estrenos.map((m) => m.id));
    const combined = [...estrenos, ...synced.filter((m) => !estrenoIds.has(m.id))];
    const totalPages = Math.ceil(combined.length / PAGE_SIZE) || 1;
    const start = (pageNum - 1) * PAGE_SIZE;
    const items: MediaItem[] = combined.slice(start, start + PAGE_SIZE).map((m) => ({
      id: m.id,
      title: m.title,
      poster: m.poster,
      rating: m.rating,
      year: m.year,
      type: 'movie' as const,
    }));

    return reply.send({ page: pageNum, totalPages, total: combined.length, items });
  }

  const result = await getCachedOrFetch(
    `movies:page:${pageNum}`,
    () => scrapeMovies(pageNum),
    600,
  );

  return reply.send({
    page: pageNum,
    totalPages: result.totalPages,
    total: result.items.length,
    items: result.items,
  });
}

function toMediaItem(item: { id: string; title: string; poster?: string; rating?: number; year?: number }, type: 'movie' | 'series'): MediaItem {
  return {
    id: item.id,
    title: item.title,
    poster: item.poster,
    rating: item.rating,
    year: item.year,
    type,
  };
}

export async function getEstrenosMoviesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { page = '1' } = request.query as any;
  const pageNum = parseInt(page) || 1;

  const data = await loadSyncData();
  const estrenos = data?.estrenoMovies || [];
  const totalPages = Math.ceil(estrenos.length / PAGE_SIZE) || 1;
  const start = (pageNum - 1) * PAGE_SIZE;
  const items: MediaItem[] = estrenos.slice(start, start + PAGE_SIZE).map((m) => toMediaItem(m, 'movie'));

  return reply.send({ page: pageNum, totalPages, total: estrenos.length, items });
}

export async function getEstrenosSeriesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { page = '1' } = request.query as any;
  const pageNum = parseInt(page) || 1;

  const data = await loadSyncData();
  const estrenos = data?.estrenoSeries || [];
  const totalPages = Math.ceil(estrenos.length / PAGE_SIZE) || 1;
  const start = (pageNum - 1) * PAGE_SIZE;
  const items: MediaItem[] = estrenos.slice(start, start + PAGE_SIZE).map((s) => toMediaItem(s, 'series'));

  return reply.send({ page: pageNum, totalPages, total: estrenos.length, items });
}

export async function getMovieDetailHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as any;

  const synced = await getFromSync();
  if (synced) {
    const movie = synced.find((m) => m.id === id);
    if (movie) {
      return reply.send({
        id: movie.id,
        title: movie.title,
        description: movie.description || `${movie.title} disponible en Veamos TV.`,
        poster: movie.poster,
        backdrop: movie.backdrop || movie.poster,
        rating: movie.rating || 7.0,
        year: movie.year || 2024,
        duration: movie.duration,
        genres: movie.genres || ['Acción', 'Drama'],
        cast: movie.cast || [{ name: 'Reparto Principal' }],
        type: 'movie' as const,
        videos: movie.videos,
      });
    }
    return reply.status(404).send({ error: 'Movie not found' });
  }

  const detail = await getCachedOrFetch(
    `movie:detail:${id}`,
    () => scrapeMovieDetail(id)!,
    600,
  );

  if (!detail) {
    return reply.status(404).send({ error: 'Movie not found' });
  }

  return reply.send(detail);
}
