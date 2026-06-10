import { FastifyRequest, FastifyReply } from 'fastify';
import { scrapePopularMovies } from '../../providers/movies';
import { scrapePopularSeries } from '../../providers/series';
import { getCachedOrFetch } from '../../cache';
import { loadSyncData, loadHomeData } from '../../services/data-store';
import { BannerItem, Section, HomeResponse, MediaItem, LiveChannel } from '../../types';

const PREVIEW_LIMIT = 10;

export async function getHomeHandler(_request: FastifyRequest, reply: FastifyReply) {
  const homeData = await getCachedOrFetch<HomeResponse>(
    'home:aggregated',
    async () => {
      const synced = await loadSyncData();

      let movies: MediaItem[] = [];
      let series: MediaItem[] = [];

      if (synced) {
        movies = (synced.estrenoMovies?.length ? synced.estrenoMovies : synced.movies).slice(0, PREVIEW_LIMIT).map((m) => ({
          id: m.id, title: m.title, poster: m.poster, rating: m.rating, year: m.year, type: 'movie' as const,
        }));
        series = (synced.estrenoSeries?.length ? synced.estrenoSeries : synced.series).slice(0, PREVIEW_LIMIT).map((s) => ({
          id: s.id, title: s.title, poster: s.poster, rating: s.rating, year: s.year, type: 'series' as const,
        }));
      } else {
        const [popMovies, popSeries] = await Promise.all([
          scrapePopularMovies(),
          scrapePopularSeries(),
        ]);
        movies = popMovies;
        series = popSeries;
      }

      const channels: LiveChannel[] = synced?.channels || [];

      const banners: BannerItem[] = movies.slice(0, 5).map((m) => ({
        ...m,
        image: m.poster || `https://placehold.co/1280x720/1a1a2e/ffffff?text=${encodeURIComponent(m.title)}`,
        description: `${m.title} - ${m.year || 'Próximamente'}`,
      }));

      const sections: Section[] = [
        {
          title: 'Películas Populares',
          type: 'movies',
          items: movies.slice(0, PREVIEW_LIMIT),
          seeAllRoute: '/movies',
          totalItems: movies.length,
        },
        {
          title: 'Series Trending',
          type: 'series',
          items: series.slice(0, PREVIEW_LIMIT),
          seeAllRoute: '/series',
          totalItems: series.length,
        },
        {
          title: 'TV en Vivo',
          type: 'live',
          items: channels.slice(0, PREVIEW_LIMIT).map((c) => ({
            id: c.id, title: c.title, poster: c.logo, type: 'live' as const,
          })),
          seeAllRoute: '/live/channels',
          totalItems: channels.length,
        },
      ];

      return { banners, sections };
    },
    300,
  );

  return reply.send(homeData);
}

export async function getHomeNewHandler(_request: FastifyRequest, reply: FastifyReply) {
  try {
    const homeData = await loadHomeData();
    if (!homeData) {
      return reply.status(404).send({ error: 'Home data not found. Run /sync/home-bysc first.' });
    }
    return reply.send(homeData);
  } catch (error) {
    return reply.status(500).send({ error: 'Failed to load home data' });
  }
}

async function findItemInHome(id: number): Promise<{ title: string; year?: string } | undefined> {
  try {
    const homeData = await loadHomeData();
    if (!homeData) return undefined;

    function search(obj: any): { title: string; year?: string } | undefined {
      if (!obj || typeof obj !== 'object') return undefined;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = search(item);
          if (found) return found;
        }
        return undefined;
      }
      if (obj.id === id) {
        return { title: obj.title || '', year: obj.year ? String(obj.year) : undefined };
      }
      for (const key of Object.keys(obj)) {
        const found = search(obj[key]);
        if (found) return found;
      }
      return undefined;
    }
    return search(homeData);
  } catch {
    return undefined;
  }
}

const SERVER_EMBEDS: Record<string, (type: string, id: number) => string> = {
  peachify: (type, id) => `https://peachify.top/embed/${type}/${id}`,
  vidcore: (type, id) => `https://vidcore.net/${type}/${id}?autoPlay=true`,
  vidnest: (type, id) => `https://vidnest.net/${type}/${id}`,
  netprime: (type, id) => `https://netprime.to/watch/${type}/${id}`,
};

export async function playerHandler(
  request: FastifyRequest<{ Params: { mediaType: string; id: string }; Querystring: { server?: string } }>,
  reply: FastifyReply
) {
  const { mediaType, id } = request.params;
  const server = request.query.server || 'peachify';
  const type = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';

  const item = await findItemInHome(Number(id));
  const title = item?.title || `${type === 'movie' ? 'Movie' : 'TV Show'} ${id}`;
  const year = item?.year || '';

  const embedFn = SERVER_EMBEDS[server] || SERVER_EMBEDS.peachify;
  const embedUrl = embedFn(type, Number(id));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}${year ? ` (${year})` : ''}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; overflow: hidden; width: 100vw; height: 100vh; }
    iframe { width: 100vw; height: 100vh; border: none; }
  </style>
</head>
<body>
  <iframe src="${embedUrl}" allowfullscreen allow="autoplay; encrypted-media"></iframe>
</body>
</html>`;

  reply.header('Content-Type', 'text/html; charset=utf-8');
  return reply.send(html);
}
