import * as cheerio from 'cheerio';
import { fetchHTML } from '../utils/http';
import { logger } from '../utils/logger';
import { MediaItem } from '../types';

const BASE_URL = 'https://www.pelisplushd.la';

export async function scrapeSearch(query: string): Promise<{ movies: MediaItem[]; series: MediaItem[] }> {
  try {
    const url = `${BASE_URL}/search?s=${encodeURIComponent(query)}`;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    const movies: MediaItem[] = [];
    const series: MediaItem[] = [];

    $('.Posters-link, a[href*="/pelicula/"], a[href*="/serie/"]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href || href === '#' || href.startsWith('javascript')) return;

      const titleRaw = $el.attr('data-title') || $el.find('.listing-content p').first().text().trim();
      const img = $el.find('img').first();
      const poster = img.attr('src') || String(img.attr('data-src') || '');
      const cleanTitle = titleRaw.replace(/^VER\s+/i, '').replace(/\s+Online\s+Gratis\s+.*$/i, '').trim();
      if (!cleanTitle || cleanTitle.length < 2) return;

      const item: MediaItem = {
        id: '',
        title: cleanTitle,
        poster: poster.startsWith('http') ? poster : poster ? `${BASE_URL}${poster}` : undefined,
        type: 'movie',
      };

      if (href.includes('/serie/')) {
        const id = `ser_${href.replace(BASE_URL, '').split('/').filter(Boolean).pop()?.replace(/-/g, '_') || ''}`;
        item.id = id;
        item.type = 'series';
        series.push(item);
      } else {
        const id = `mov_${href.replace(BASE_URL, '').split('/').filter(Boolean).pop()?.replace(/-/g, '_') || ''}`;
        item.id = id;
        item.type = 'movie';
        movies.push(item);
      }
    });

    return { movies, series };
  } catch (error) {
    logger.error({ error, query }, 'Failed to scrape search');
    return { movies: [], series: [] };
  }
}
