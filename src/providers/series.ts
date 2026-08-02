import * as cheerio from 'cheerio';
import { fetchHTML } from '../utils/http';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { MediaItem, ContentDetail, Season, Episode, VideoLanguage, VideoServer } from '../types';
import { resolveVideoUrl } from '../services/video-resolver';
import { extractDetailMeta } from './pelisplus-meta';

const BASE_URL = 'https://www.pelisplushd.la';
const SERIES_URL = `${BASE_URL}/series`;

function extractIdFromUrl(url: string): string {
  const parts = url.replace(BASE_URL, '').split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return last.replace(/-/g, '_');
}

function isErrorPage($: cheerio.CheerioAPI): boolean {
  const title = $('title').first().text().trim().toLowerCase();
  const h1 = $('h1').first().text().trim();
  return title.includes('404') || title.includes('not found') || title.includes('error') || h1 === '404' || h1 === 'Page not found';
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

export async function scrapeSeries(page = 1): Promise<{ items: MediaItem[]; totalPages: number }> {
  const cacheKey = `series:page:${page}`;
  const cached = memoryCache.get<{ items: MediaItem[]; totalPages: number }>(cacheKey);
  if (cached) return cached;

  try {
    const url = page > 1 ? `${SERIES_URL}?page=${page}` : SERIES_URL;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    const series: MediaItem[] = [];

    $('.Posters-link, a[href*="/serie/"]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href || href === '#' || href.startsWith('javascript') || !href.includes('/serie/')) return;

      const titleRaw = $el.attr('data-title') || $el.find('.listing-content p').first().text().trim();
      const img = $el.find('img').first();
      const poster = img.attr('src') || String(img.attr('data-src') || '');
      const ratingEl = $el.find('.rating, .calification, .stars').first().text().trim();
      const match = ratingEl.match(/([\d.]+)/);

      if (titleRaw && titleRaw.length > 1) {
        const cleanTitle = titleRaw.replace(/^VER\s+/i, '').replace(/\s+Online\s+Gratis\s+.*$/i, '').trim();
        if (cleanTitle.length < 2) return;
        series.push({
          id: `ser_${extractIdFromUrl(href)}`,
          title: cleanTitle,
          poster: poster.startsWith('http') ? poster : poster ? `${BASE_URL}${poster}` : undefined,
          rating: match ? parseFloat(match[1]) : undefined,
          type: 'series',
        });
      }
    });

    const totalPages = parseTotalPages($);

    const result = {
      items: series.length > 0 ? series.slice(0, 50) : getFallbackSeries(),
      totalPages,
    };

    memoryCache.set(cacheKey, result, 600_000);
    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to scrape series');
    return { items: getFallbackSeries(), totalPages: 1 };
  }
}

export async function scrapePopularSeries(): Promise<MediaItem[]> {
  const cacheKey = 'series:popular';
  const cached = memoryCache.get<MediaItem[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${SERIES_URL}/populares`;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    const series: MediaItem[] = [];

    $('.Posters-link, a[href*="/serie/"]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href || href === '#' || href.startsWith('javascript') || !href.includes('/serie/')) return;

      const titleRaw = $el.attr('data-title') || $el.find('.listing-content p').first().text().trim();
      const img = $el.find('img').first();
      const poster = img.attr('src') || String(img.attr('data-src') || '');
      const ratingEl = $el.find('.rating, .calification, .stars').first().text().trim();
      const match = ratingEl.match(/([\d.]+)/);

      if (titleRaw && titleRaw.length > 1) {
        const cleanTitle = titleRaw.replace(/^VER\s+/i, '').replace(/\s+Online\s+Gratis\s+.*$/i, '').trim();
        if (cleanTitle.length < 2) return;
        series.push({
          id: `ser_${extractIdFromUrl(href)}`,
          title: cleanTitle,
          poster: poster.startsWith('http') ? poster : poster ? `${BASE_URL}${poster}` : undefined,
          rating: match ? parseFloat(match[1]) : undefined,
          type: 'series',
        });
      }
    });

    const result = series.slice(0, 50);
    memoryCache.set(cacheKey, result, 600_000);
    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to scrape popular series');
    return getFallbackSeries();
  }
}

export async function scrapeSeriesDetail(id: string): Promise<ContentDetail | null> {
  const cacheKey = `series:detail:${id}`;
  const cached = memoryCache.get<ContentDetail>(cacheKey);
  if (cached) return cached;

  try {
    const slug = id.replace(/^ser_/, '').replace(/_/g, '-');
    const url = `${BASE_URL}/serie/${slug}`;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    if (isErrorPage($)) {
      logger.warn({ id, url }, 'Series detail page is a 404/error');
      return getFallbackSeriesDetail(id);
    }

    const title = $('h1').first().text().trim();
    if (!title || title.length < 2 || title === '404') {
      return getFallbackSeriesDetail(id);
    }

    const meta = extractDetailMeta($);
    const poster = meta.poster;
    const backdrop = $('.backdrop img, .background img').first().attr('src') || poster;
    const rating = meta.rating || 8.0;

    const seasons: Season[] = [];
    const seasonMap = new Map<number, { title: string; episodes: Episode[] }>();

    $('a[href*="temporada"][href*="capitulo"]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const epTitle = $el.text().trim() || 'Episodio';

      const match = href.match(/temporada\/(\d+)\/capitulo\/(\d+)/i);
      if (!match) return;

      const seasonNum = parseInt(match[1]);
      const epNum = parseInt(match[2]);

      if (!seasonMap.has(seasonNum)) {
        seasonMap.set(seasonNum, { title: `Temporada ${seasonNum}`, episodes: [] });
      }

      const seasonData = seasonMap.get(seasonNum)!;
      seasonData.episodes.push({
        id: `${id}_s${seasonNum}e${epNum}`,
        title: epTitle,
        duration: '45m',
        episode_number: epNum,
      });
    });

    if (seasonMap.size > 0) {
      for (const [seasonNum, data] of [...seasonMap.entries()].sort(([a], [b]) => a - b)) {
        data.episodes.sort((a, b) => a.episode_number - b.episode_number);
        seasons.push({
          season_number: seasonNum,
          title: data.title,
          episodes: data.episodes,
        });
      }
    } else {
      seasons.push({ season_number: 1, title: 'Temporada 1', episodes: getDefaultEpisodes(id, 1) });
    }

    const posterUrl = poster.startsWith('http') ? poster : poster ? `${BASE_URL}${poster}` : undefined;
    const backdropUrl = backdrop.startsWith('http') ? backdrop : backdrop ? `${BASE_URL}${backdrop}` : posterUrl;

    let videos: VideoLanguage[] = [];
    const episodeVideosMap = new Map<string, VideoLanguage[]>();
    try {
      const allEpisodes: { seasonNum: number; epNum: number; epId: string }[] = [];
      for (const s of seasons) {
        for (const ep of s.episodes) {
          allEpisodes.push({ seasonNum: s.season_number, epNum: ep.episode_number, epId: ep.id });
        }
      }

      const concurrency = 5;
      for (let i = 0; i < allEpisodes.length; i += concurrency) {
        const batch = allEpisodes.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map(({ seasonNum, epNum }) => {
            const epUrl = `${BASE_URL}/serie/${slug}/temporada/${seasonNum}/capitulo/${epNum}`;
            return scrapeEpisodeVideos(epUrl);
          }),
        );
        results.forEach((res, idx) => {
          const epId = batch[idx].epId;
          if (res.status === 'fulfilled' && res.value.length > 0) {
            episodeVideosMap.set(epId, res.value);
          }
        });
      }

      if (allEpisodes.length > 0) {
        const firstId = allEpisodes[0].epId;
        videos = episodeVideosMap.get(firstId) || [];
      }
    } catch { /* videos will be empty */ }

    for (const s of seasons) {
      for (const ep of s.episodes) {
        const epVideos = episodeVideosMap.get(ep.id);
        if (epVideos && epVideos.length > 0) {
          ep.videos = epVideos;
        }
      }
    }

    const detail: ContentDetail = {
      id,
      title,
      description: meta.description,
      poster: posterUrl,
      backdrop: backdropUrl,
      rating,
      year: meta.year || 2024,
      genres: meta.genres.length > 0 ? meta.genres : ['Drama', 'Action'],
      cast: meta.cast.length > 0 ? meta.cast.slice(0, 10) : [{ name: 'Reparto Principal' }],
      type: 'series',
      seasons: seasons.length > 0 ? seasons : getDefaultSeasons(id),
      videos: videos.length > 0 ? videos : undefined,
    };

    memoryCache.set(cacheKey, detail, 600_000);
    return detail;
  } catch (error) {
    logger.error({ error, id }, 'Failed to scrape series detail');
    return getFallbackSeriesDetail(id);
  }
}

function extractPanicButtonVideos($: cheerio.CheerioAPI, serverNames: string[]): VideoLanguage[] {
  const urls: VideoServer[] = [];
  $('#link_url span').each((i, el) => {
    const url = $(el).attr('url');
    if (url) {
      urls.push({ name: serverNames[i] || `server ${i + 1}`, url });
    }
  });
  if (urls.length > 0) {
    return [{ language: 'Latino', servers: urls }];
  }
  return [];
}

function extractSeriesEpisodeVideos($: cheerio.CheerioAPI): VideoLanguage[] {
  const serverNames: string[] = [];
  $('.TbVideoNv li a').each((_, el) => {
    const name = $(el).text().trim();
    if (name) serverNames.push(name);
  });
  const panicVideos = extractPanicButtonVideos($, serverNames);
  if (panicVideos.length > 0) return panicVideos;

  const movieVideos = extractMovieStyleVideos($);
  if (movieVideos.length > 0) return movieVideos;

  return [];
}

function extractMovieStyleVideos($: cheerio.CheerioAPI): VideoLanguage[] {
  const langMap = new Map<string, VideoServer[]>();
  $('li.playurl[data-name][data-url]').each((_, el) => {
    const $el = $(el);
    const language = $el.attr('data-name')?.trim();
    const url = $el.attr('data-url')?.trim();
    const serverName = $el.find('a').first().text().trim();
    if (!language || !url) return;
    if (!langMap.has(language)) langMap.set(language, []);
    langMap.get(language)!.push({ name: serverName || 'server', url });
  });
  return Array.from(langMap.entries()).map(([language, servers]) => ({
    language,
    servers,
  }));
}

async function resolveVideos(videos: VideoLanguage[]): Promise<VideoLanguage[]> {
  const resolved: VideoLanguage[] = [];
  for (const lang of videos) {
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

export async function scrapeEpisodeVideos(episodeUrl: string): Promise<VideoLanguage[]> {
  const cacheKey = `episode:videos:${episodeUrl}`;
  const cached = memoryCache.get<VideoLanguage[]>(cacheKey);
  if (cached) return cached;

  try {
    const fullUrl = episodeUrl.startsWith('http') ? episodeUrl : `${BASE_URL}${episodeUrl}`;
    const html = await fetchHTML(fullUrl);
    const $ = cheerio.load(html);
    const rawVideos = extractSeriesEpisodeVideos($);
    const videos = await resolveVideos(rawVideos);
    memoryCache.set(cacheKey, videos, 600_000);
    return videos;
  } catch {
    return [];
  }
}

function getDefaultEpisodes(seriesId: string, seasonNum: number): Episode[] {
  return Array.from({ length: 8 }, (_, i) => ({
    id: `${seriesId}_s${seasonNum}e${i + 1}`,
    title: `Episode ${i + 1}`,
    duration: '45m',
    episode_number: i + 1,
  }));
}

function getDefaultSeasons(seriesId: string): Season[] {
  return [{
    season_number: 1,
    title: 'Season 1',
    episodes: getDefaultEpisodes(seriesId, 1),
  }];
}

const FALLBACK_SERIES: MediaItem[] = [
  { id: 'ser_breaking_bad', title: 'Breaking Bad', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=Breaking+Bad', rating: 9.5, year: 2008, type: 'series' },
  { id: 'ser_game_of_thrones', title: 'Game of Thrones', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=Game+of+Thrones', rating: 9.2, year: 2011, type: 'series' },
  { id: 'ser_stranger_things', title: 'Stranger Things', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=Stranger+Things', rating: 8.7, year: 2016, type: 'series' },
  { id: 'ser_the_last_kingdom', title: 'The Last Kingdom', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=The+Last+Kingdom', rating: 8.6, year: 2015, type: 'series' },
  { id: 'ser_the_witcher', title: 'The Witcher', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=The+Witcher', rating: 8.3, year: 2019, type: 'series' },
  { id: 'ser_money_heist', title: 'Money Heist', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=Money+Heist', rating: 8.3, year: 2017, type: 'series' },
  { id: 'ser_squid_game', title: 'Squid Game', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=Squid+Game', rating: 8.5, year: 2021, type: 'series' },
  { id: 'ser_the_mandalorian', title: 'The Mandalorian', poster: 'https://placehold.co/300x450/1a1a2e/ffffff?text=The+Mandalorian', rating: 8.8, year: 2019, type: 'series' },
];

function getFallbackSeries(): MediaItem[] {
  return FALLBACK_SERIES;
}

function getFallbackSeriesDetail(id: string): ContentDetail | null {
  const cleanId = id.replace(/^ser_/, '');
  const fallback = FALLBACK_SERIES.find(
    (s) => s.id === id || s.id.replace('ser_', '') === cleanId,
  );
  if (fallback) {
    return {
      id,
      title: fallback.title,
      description: `${fallback.title} - Una serie emocionante llena de drama y aventura.`,
      poster: fallback.poster,
      backdrop: fallback.poster,
      rating: fallback.rating || 8.0,
      year: fallback.year || 2024,
      genres: ['Drama', 'Action'],
      cast: [{ name: 'Reparto Principal' }],
      type: 'series',
      seasons: getDefaultSeasons(id),
    };
  }
  return null;
}
