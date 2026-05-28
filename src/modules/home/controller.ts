import fs from 'fs';
import path from 'path';
import { FastifyRequest, FastifyReply } from 'fastify';
import { scrapePopularMovies } from '../../providers/movies';
import { scrapePopularSeries } from '../../providers/series';
import { getCachedOrFetch } from '../../cache';
import { loadSyncData } from '../../services/data-store';
import { BannerItem, Section, HomeResponse, MediaItem, LiveChannel } from '../../types';

const PREVIEW_LIMIT = 10;

export async function getHomeHandler(_request: FastifyRequest, reply: FastifyReply) {
  const homeData = await getCachedOrFetch<HomeResponse>(
    'home:aggregated',
    async () => {
      const synced = loadSyncData();

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
    const filePath = path.join(process.cwd(), 'data', 'sync-data.home.json');
    if (!fs.existsSync(filePath)) {
      return reply.status(404).send({ error: 'Home data not found. Run /sync/home-bysc first.' });
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const homeData = JSON.parse(raw);
    return reply.send(homeData);
  } catch (error) {
    return reply.status(500).send({ error: 'Failed to load home data' });
  }
}
