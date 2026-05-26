import { FastifyRequest, FastifyReply } from 'fastify';
import { scrapeMovies, scrapeMovieDetail } from '../../providers/movies';
import { getCachedOrFetch } from '../../cache';
import { loadSyncData } from '../../services/data-store';
import { SyncMovie, MediaItem } from '../../types';

const PAGE_SIZE = 24;

function getFromSync(): SyncMovie[] | null {
  const data = loadSyncData();
  return data?.movies || null;
}

export async function getMoviesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { page = '1' } = request.query as any;
  const pageNum = parseInt(page) || 1;

  const synced = getFromSync();
  if (synced) {
    const totalPages = Math.ceil(synced.length / PAGE_SIZE) || 1;
    const start = (pageNum - 1) * PAGE_SIZE;
    const items: MediaItem[] = synced.slice(start, start + PAGE_SIZE).map((m) => ({
      id: m.id,
      title: m.title,
      poster: m.poster,
      rating: m.rating,
      year: m.year,
      type: 'movie' as const,
    }));

    return reply.send({ page: pageNum, totalPages, total: synced.length, items });
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

export async function getMovieDetailHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as any;

  const synced = getFromSync();
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
