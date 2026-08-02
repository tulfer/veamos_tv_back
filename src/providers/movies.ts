import * as cheerio from 'cheerio';
import { fetchHTML } from '../utils/http';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { MediaItem, ContentDetail, VideoLanguage, VideoServer } from '../types';
import { resolveVideoUrl } from '../services/video-resolver';
import { extractDetailMeta } from './pelisplus-meta';

const BASE_URL = 'https://www.pelisplushd.la';
const MOVIES_URL = `${BASE_URL}/peliculas/estrenos`;

function extractIdFromUrl(url: string): string {
  const parts = url.replace(BASE_URL, '').split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return last.replace(/-/g, '_');
}

function extractRating(text: string): number {
  const match = text.match(/([\d.]+)\/10/);
  return match ? parseFloat(match[1]) : 0;
}

function isErrorPage($: cheerio.CheerioAPI): boolean {
  const title = $('title').first().text().trim().toLowerCase();
  const h1 = $('h1').first().text().trim();
  const bodyText = $('body').text().trim();
  return (
    title.includes('404') ||
    title.includes('not found') ||
    h1 === '404' ||
    bodyText.includes('404') ||
    bodyText.length < 200
  );
}

function parseTotalPages($: cheerio.CheerioAPI): number {
  const pages: number[] = [];
  $('.page-item .page-link').each((_, el) => {
    const text = $(el).text().trim();
    const num = parseInt(text);
    if (!isNaN(num)) pages.push(num);
  });
  if (pages.length > 0) return Math.max(...pages);

  const links = $('.page-item a').toArray();
  const lastHref = links.length > 0 ? $(links[links.length - 1]).attr('href') : '';
  if (lastHref) {
    const match = lastHref.match(/page[=/](\d+)/);
    if (match) return parseInt(match[1]);
  }

  return 1;
}

export async function scrapeMovies(page = 1): Promise<{ items: MediaItem[]; totalPages: number }> {
  const cacheKey = `movies:page:${page}`;
  const cached = memoryCache.get<{ items: MediaItem[]; totalPages: number }>(cacheKey);
  if (cached) return cached;

  try {
    const url = page > 1 ? `${MOVIES_URL}?page=${page}` : MOVIES_URL;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    const movies: MediaItem[] = [];

    $('.Posters-link, a[href*="/pelicula/"]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href || href === '#' || href.startsWith('javascript') || !href.includes('/pelicula/')) return;

      const titleRaw = $el.attr('data-title') || $el.find('.listing-content p').first().text().trim();
      const img = $el.find('img').first();
      const poster = img.attr('src') || String(img.attr('data-src') || '');
      const ratingEl = $el.find('.rating, .calification, .stars').first().text().trim();
      const yearText = $el.find('.year, .date').first().text().trim();
      const year = parseInt(yearText) || 0;

      if (titleRaw && titleRaw.length > 1) {
        const cleanTitle = titleRaw.replace(/^VER\s+/i, '').replace(/\s+Online\s+Gratis\s+.*$/i, '').trim();
        if (cleanTitle.length < 2) return;
        movies.push({
          id: `mov_${extractIdFromUrl(href)}`,
          title: cleanTitle,
          poster: poster.startsWith('http') ? poster : poster ? `${BASE_URL}${poster}` : undefined,
          rating: ratingEl ? extractRating(ratingEl) : undefined,
          year: year || undefined,
          type: 'movie',
        });
      }
    });

    const totalPages = parseTotalPages($);

    const result = {
      items: movies.length > 0 ? movies.slice(0, 50) : getFallbackMovies(),
      totalPages,
    };

    memoryCache.set(cacheKey, result, 600_000);
    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to scrape movies');
    return { items: getFallbackMovies(), totalPages: 1 };
  }
}

export async function scrapePopularMovies(): Promise<MediaItem[]> {
  const cacheKey = 'movies:popular';
  const cached = memoryCache.get<MediaItem[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${MOVIES_URL}/populares`;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    const movies: MediaItem[] = [];

    $('.Posters-link, a[href*="/pelicula/"]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href || href === '#' || href.startsWith('javascript') || !href.includes('/pelicula/')) return;

      const titleRaw = $el.attr('data-title') || $el.find('.listing-content p').first().text().trim();
      const img = $el.find('img').first();
      const poster = img.attr('src') || String(img.attr('data-src') || '');
      const ratingEl = $el.find('.rating, .calification, .stars').first().text().trim();
      const yearText = $el.find('.year, .date').first().text().trim();
      const year = parseInt(yearText) || 0;

      if (titleRaw && titleRaw.length > 1) {
        const cleanTitle = titleRaw.replace(/^VER\s+/i, '').replace(/\s+Online\s+Gratis\s+.*$/i, '').trim();
        if (cleanTitle.length < 2) return;
        movies.push({
          id: `mov_${extractIdFromUrl(href)}`,
          title: cleanTitle,
          poster: poster.startsWith('http') ? poster : poster ? `${BASE_URL}${poster}` : undefined,
          rating: ratingEl ? extractRating(ratingEl) : undefined,
          year: year || undefined,
          type: 'movie',
        });
      }
    });

    const result = movies.slice(0, 50);
    memoryCache.set(cacheKey, result, 600_000);
    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to scrape popular movies');
    return getFallbackMovies();
  }
}

export async function scrapeMovieDetail(id: string): Promise<ContentDetail | null> {
  const cacheKey = `movie:detail:${id}`;
  const cached = memoryCache.get<ContentDetail>(cacheKey);
  if (cached) return cached;

  const slug = id.replace(/^mov_/, '').replace(/_/g, '-');
  const url = `${BASE_URL}/pelicula/${slug}`;

  try {
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    if (isErrorPage($)) {
      logger.warn({ id, url }, 'Movie detail page is a 404/error');
      return getFallbackMovieDetail(id);
    }

    const title = $('h1').first().text().trim();
    if (!title || title.length < 2 || title === '404') {
      return getFallbackMovieDetail(id);
    }

    const meta = extractDetailMeta($);
    const poster = meta.poster;
    const backdrop = $('.backdrop img, .background img').first().attr('src') || poster;
    const rating = meta.rating || 7.0;
    const year = meta.year || 2024;
    const duration = $('.duration, .runtime').first().text().trim() || '2h';

    const posterUrl = poster.startsWith('http') ? poster : poster ? `${BASE_URL}${poster}` : undefined;
    const backdropUrl = backdrop.startsWith('http') ? backdrop : backdrop ? `${BASE_URL}${backdrop}` : posterUrl;

    const rawVideos = extractVideoLanguages($);
    const videos = rawVideos.length > 0 ? await resolveVideoServers(rawVideos) : [];

    const detail: ContentDetail = {
      id,
      title,
      description: meta.description,
      poster: posterUrl,
      backdrop: backdropUrl,
      rating,
      year,
      duration: duration || undefined,
      genres: meta.genres.length > 0 ? meta.genres : ['Action', 'Drama'],
      cast: meta.cast.length > 0 ? meta.cast.slice(0, 10) : [{ name: 'Reparto Principal' }],
      type: 'movie',
      videos: videos.length > 0 ? videos : undefined,
    };

    memoryCache.set(cacheKey, detail, 600_000);
    return detail;
  } catch (error) {
    logger.error({ error, id, url }, 'Failed to scrape movie detail');
    return getFallbackMovieDetail(id);
  }
}

function extractVideoLanguages($: cheerio.CheerioAPI): VideoLanguage[] {
  const langMap = new Map<string, VideoServer[]>();

  $('li.playurl[data-name][data-url]').each((_, el) => {
    const $el = $(el);
    const language = $el.attr('data-name')?.trim();
    const url = $el.attr('data-url')?.trim();
    const serverName = $el.find('a').first().text().trim();
    if (!language || !url) return;

    if (!langMap.has(language)) {
      langMap.set(language, []);
    }
    langMap.get(language)!.push({ name: serverName || 'server', url });
  });

  return Array.from(langMap.entries()).map(([language, servers]) => ({
    language,
    servers,
  }));
}

async function resolveVideoServers(videoLanguages: VideoLanguage[]): Promise<VideoLanguage[]> {
  const resolved: VideoLanguage[] = [];

  for (const lang of videoLanguages) {
    const resolvedServers = await Promise.all(
      lang.servers.map(async (server) => {
        const resolvedUrl = await resolveVideoUrl(server.url);
        return { ...server, url: resolvedUrl };
      }),
    );
    resolved.push({ language: lang.language, servers: resolvedServers });
  }

  return resolved;
}

const FALLBACK_MOVIES: MediaItem[] = [
  { id: 'mov_john_wick_4', title: 'John Wick 4', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=John+Wick+4', rating: 8.9, year: 2023, type: 'movie' },
  { id: 'mov_dune_part_two', title: 'Dune: Part Two', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=Dune+Part+Two', rating: 8.8, year: 2024, type: 'movie' },
  { id: 'mov_oppenheimer', title: 'Oppenheimer', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=Oppenheimer', rating: 8.9, year: 2023, type: 'movie' },
  { id: 'mov_the_batman', title: 'The Batman', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=The+Batman', rating: 8.2, year: 2022, type: 'movie' },
  { id: 'mov_spider_man', title: 'Spider-Man: No Way Home', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=Spider-Man', rating: 8.5, year: 2021, type: 'movie' },
  { id: 'mov_the_dark_knight', title: 'The Dark Knight', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=The+Dark+Knight', rating: 9.0, year: 2008, type: 'movie' },
  { id: 'mov_interstellar', title: 'Interstellar', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=Interstellar', rating: 8.7, year: 2014, type: 'movie' },
  { id: 'mov_avengers_endgame', title: 'Avengers: Endgame', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=Avengers+Endgame', rating: 8.4, year: 2019, type: 'movie' },
  { id: 'mov_inception', title: 'Inception', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=Inception', rating: 8.8, year: 2010, type: 'movie' },
  { id: 'mov_the_matrix', title: 'The Matrix', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=The+Matrix', rating: 8.7, year: 1999, type: 'movie' },
];

function getFallbackMovies(): MediaItem[] {
  return FALLBACK_MOVIES;
}

function getFallbackMovieDetail(id: string): ContentDetail | null {
  const cleanId = id.replace(/^mov_/, '');
  const fallback = FALLBACK_MOVIES.find(
    (m) => m.id === id || m.id.replace('mov_', '') === cleanId || cleanId === m.id.replace('mov_', '').replace(/_/g, ''),
  );
  if (fallback) {
    return {
      id,
      title: fallback.title,
      description: `${fallback.title} - Película llena de acción y aventura.`,
      poster: fallback.poster,
      backdrop: fallback.poster,
      rating: fallback.rating || 7.0,
      year: fallback.year || 2024,
      duration: '2h 30m',
      genres: ['Action', 'Drama'],
      cast: [{ name: 'Reparto Principal' }],
      type: 'movie',
    };
  }
  return null;
}
