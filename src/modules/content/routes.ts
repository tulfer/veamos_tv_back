import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { scrapeMovieDetail } from '../../providers/movies';
import { scrapeSeriesDetail } from '../../providers/series';
import { fetchLiveChannels } from '../../providers/live-tv';
import { getCachedOrFetch, memoryCache } from '../../cache';
import { loadSyncData } from '../../services/data-store';
import { getMovieDetailContent, getSeriesDetailContent } from '../../services/content-detail';
import { MediaItem, ContentDetail, LiveChannel } from '../../types';

const UNAVAILABLE_MSG = 'Este contenido no está disponible en este momento.';

function idToTitle(id: string): string {
  return id
    .replace(/^(mov|ser|live)_/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function channelToDetail(ch: LiveChannel): ContentDetail {
  return {
    id: ch.id,
    title: ch.title,
    description: `Canal en vivo - ${ch.group || 'General'} ${ch.country ? `(${ch.country})` : ''}`,
    poster: ch.logo,
    backdrop: ch.logo,
    rating: 0,
    year: 0,
    genres: ch.group ? [ch.group] : ['TV'],
    cast: [],
    type: 'live',
    video: ch.url ? { stream_url: ch.url, type: 'hls', quality: 'live' } : undefined,
  };
}

function generateFallbackDetail(id: string, type: 'movie' | 'series'): ContentDetail {
  const cacheKey = type === 'movie' ? 'movies:page:1' : 'series:page:1';
  const cached = memoryCache.get<{ items: MediaItem[] }>(cacheKey);
  const item = cached?.items.find((m) => m.id === id);
  const title = item?.title || idToTitle(id);

  return {
    id,
    title,
    description: UNAVAILABLE_MSG,
    poster: item?.poster,
    backdrop: item?.poster,
    rating: item?.rating || 7.0,
    year: item?.year || 2024,
    duration: type === 'movie' ? '2h' : undefined,
    genres: ['Acción', 'Drama'],
    cast: [{ name: 'Reparto Principal' }],
    type,
    seasons: type === 'series' ? [{
      season_number: 1,
      title: 'Temporada 1',
      episodes: Array.from({ length: 8 }, (_, i) => ({
        id: `${id}_s1e${i + 1}`,
        title: `Capítulo ${i + 1}`,
        duration: '45m',
        episode_number: i + 1,
      })),
    }] : undefined,
  };
}

export async function contentRoutes(app: FastifyInstance) {
  app.get('/content/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as any;

    if (!id || typeof id !== 'string') {
      return reply.status(400).send({ error: 'Missing or invalid content ID' });
    }

    if (id.startsWith('live_')) {
      // Intentar obtener el canal desde los datos sincronizados primero
      const synced = await loadSyncData();
      const syncedChannels = synced?.channels;
      let channel: LiveChannel | undefined;

      if (syncedChannels && syncedChannels.length > 0) {
        channel = syncedChannels.find((ch) => ch.id === id);
      }

      // Si no se encuentra en los datos sincronizados, buscar en el proveedor (caché)
      if (!channel) {
        const channels = await getCachedOrFetch('live:channels', () => fetchLiveChannels(), 300);
        channel = channels.find((ch: LiveChannel) => ch.id === id);
      }

      if (!channel) {
        return reply.status(404).send({ error: 'Channel not found', id });
      }
      return reply.send(channelToDetail(channel));
    }

    const type = id.startsWith('ser_') ? 'series' : (id.startsWith('mov_') ? 'movie' : null);
    if (!type) {
      return reply.status(400).send({
        error: 'Invalid content ID format',
        message: 'ID must start with mov_ (movie), ser_ (series), or live_ (channel)',
      });
    }

    const syncedDetail = type === 'movie'
      ? await getMovieDetailContent(id)
      : await getSeriesDetailContent(id);
    if (syncedDetail) {
      return reply.send(syncedDetail);
    }

    const detail = await getCachedOrFetch(
      `content:detail:${id}`,
      async () => {
        const scraped = type === 'series' ? await scrapeSeriesDetail(id) : await scrapeMovieDetail(id);
        if (scraped) return scraped;
        return generateFallbackDetail(id, type);
      },
      600,
    );

    return reply.send(detail);
  });
}
