import * as cheerio from 'cheerio';
import { httpClient } from '../utils/http';
import { ContentDetail, Episode, Season, VideoLanguage, VideoServer } from '../types';
import { isUnsupportedVideoHost } from '../utils/unsupported-video-hosts';
import { memoryCache } from '../cache/memory';
import { logger } from '../utils/logger';

/**
 * Proveedor de respaldo para películas y series: PelisPedia.
 *
 * Mismo slug que GNULA/PelisPlus (.mov/pelicula/<slug> y /serie/<slug>).
 * Cada página de película/capítulo expone un iframe hacia el "selector" de
 * servidores (xupalace.org), cuyos espejos reales viven en <li onclick>
 * dentro de `.OD_1`. Aquí se extraen esos espejos y se filtran los hosts no
 * soportados (isUnsupportedVideoHost) sin resolverlos a m3u8.
 */

const BASE_URL = 'https://pelispedia.mov';

const LANG_NAMES: Record<string, string> = {
  LAT: 'Latino',
  ESP: 'Español',
  SUB: 'Subtitulado',
  ENG: 'Inglés',
  ESU: 'Español',
  SUBT: 'Subtitulado',
};

async function fetchText(url: string): Promise<string | null> {
  let lastError: { message: string } | undefined;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await httpClient.get(url, { timeout: 15000, validateStatus: () => true });
      return typeof res.data === 'string' ? res.data : null;
    } catch (error) {
      lastError = error as { message: string };
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  if (lastError) logger.warn({ error: lastError.message, url }, 'PelisPedia: fetch fallido');
  return null;
}

function isErrorPage($: cheerio.CheerioAPI): boolean {
  const title = $('title').first().text().trim().toLowerCase();
  const h1 = $('h1').first().text().trim();
  return title.includes('404') || title.includes('not found') || h1 === '404' || $('body').text().trim().length < 200;
}

interface PelisPediaMeta {
  title: string;
  description: string;
  poster?: string;
  rating?: number;
  year?: number;
  genres: string[];
}

function extractMeta($: cheerio.CheerioAPI): PelisPediaMeta | null {
  const title = $('h1').first().text().trim();
  if (!title || title === '404') return null;

  let rating: number | undefined;
  let year: number | undefined;
  let genres: string[] = [];
  let description = $('meta[name="description"]').first().attr('content') || '';

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html() || '';
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const aggregate = data.aggregateRating as Record<string, unknown> | undefined;
      if (aggregate?.ratingValue != null) rating = parseFloat(String(aggregate.ratingValue)) || undefined;
      if (data.datePublished) year = parseInt(String(data.datePublished)) || undefined;
      if (Array.isArray(data.genre)) genres = (data.genre as string[]).map((g) => String(g).trim()).filter(Boolean);
      if (!description && typeof data.description === 'string') description = data.description;
    } catch {
      // JSON-LD opcional; si falla seguimos con los meta tags.
    }
  });

  return {
    title,
    description,
    poster: $('meta[property="og:image"]').first().attr('content') || $('meta[name="twitter:image"]').first().attr('content') || undefined,
    rating,
    year,
    genres,
  };
}

function extractIframeUrl(html: string): string | null {
  return (
    html.match(/<div[^>]*class=["'][^"']*player-content[^"']*["'][^>]*>[\s\S]*?<iframe\b[^>]*src=["']([^"']+)/i)?.[1] ||
    html.match(/<iframe\b[^>]*src="(https?:\/\/xupalace\.org\/[^"]+)"[^>]*>/i)?.[1] ||
    html.match(/<iframe\b[^>]*src=["']([^"']+)/i)?.[1]
  );
}

function langNameFromImage(imgSrc: string | undefined): string {
  const match = (imgSrc || '').match(/([A-Z]{2,6})(?:\.[\w]+)?$/i);
  const code = match ? match[1].toUpperCase() : 'LAT';
  return LANG_NAMES[code] || code;
}

/** Expande el "selector" de servidores de PelisPedia (embed xupalace): cada
 * <li> guarda un espejo real en su onclick go_to_playerVast('URL'). */
async function expandPlayerEmbed(embedUrl: string): Promise<Map<string, VideoServer[]>> {
  const result = new Map<string, VideoServer[]>();
  const embedHtml = await fetchText(embedUrl);
  if (!embedHtml) return result;

  const langLabels: Record<string, string> = {};
  const langRe = /<li[^>]*data-lang=["']([^"']+)["'][^>]*>[\s\S]*?<img[^>]*src=["']([^"']+\/img\/[^"']+\.(?:png|webp|jpg))["'][^>]*>/gi;
  let langMatch: ReturnType<RegExp['exec']> | null;
  while ((langMatch = langRe.exec(embedHtml)) !== null) {
    langLabels[langMatch[1]] = langNameFromImage(langMatch[2]);
  }

  const liRe = /<li\b[^>]*\bonclick="([^"]*)"[^>]*data-lang=["']([^"']+)["'][^>]*>([\s\S]*?)<\/li>/gi;
  let match: ReturnType<RegExp['exec']> | null;
  while ((match = liRe.exec(embedHtml)) !== null) {
    const onclick = match[1] || '';
    const langKey = match[2] || '0';
    const urlRaw = onclick.match(/go_to_playerVast\(['"]([^'"]+)['"]/i)?.[1];
    if (!urlRaw) continue;
    const url = urlRaw.replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').trim();
    if (!/^https?:\/\//i.test(url) || isUnsupportedVideoHost(url)) continue;
    const languageName = langLabels[langKey] || 'Latino';
    const servers = result.get(languageName) || [];
    const spanName = match[3].match(/<span[^>]*>([^<]+)<\/span>/i)?.[1]?.trim();
    servers.push({ name: spanName || `Servidor ${servers.length + 1}`, url });
    result.set(languageName, servers);
  }

  return result;
}

export async function scrapePelisPediaMovieDetail(id: string): Promise<ContentDetail | null> {
  const cacheKey = `pelispedia:movie:${id}`;
  const cached = memoryCache.get<ContentDetail>(cacheKey);
  if (cached) return cached;

  const slug = id.replace(/^mov_/, '').replace(/_/g, '-');
  const url = `${BASE_URL}/pelicula/${slug}`;
  const html = await fetchText(url);
  if (!html) return null;

  const $ = cheerio.load(html);
  if (isErrorPage($)) return null;
  const meta = extractMeta($);
  if (!meta) return null;

  const videos: VideoLanguage[] = [];
  const iframeUrl = extractIframeUrl(html);
  if (iframeUrl) {
    const languages = await expandPlayerEmbed(iframeUrl);
    for (const [language, servers] of languages) {
      videos.push({ language, servers });
    }
  }

  const detail: ContentDetail = {
    id,
    title: meta.title,
    description: meta.description,
    poster: meta.poster,
    backdrop: meta.poster,
    rating: meta.rating || 8.0,
    year: meta.year || 2024,
    genres: meta.genres.length > 0 ? meta.genres : ['Acción', 'Drama'],
    cast: [{ name: 'Reparto Principal' }],
    type: 'movie',
    videos: videos.length > 0 ? videos : undefined,
  };

  memoryCache.set(cacheKey, detail, 600_000);
  return detail;
}

function extractChapters($: cheerio.CheerioAPI): { seasonNum: number; epNum: number; href: string }[] {
  const episodes: { seasonNum: number; epNum: number; href: string }[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/temporada\/(\d+)\/capitulo\/(\d+)/i);
    if (!match) return;
    const key = `${match[1]}_${match[2]}`;
    if (seen.has(key)) return;
    seen.add(key);
    episodes.push({ seasonNum: parseInt(match[1]), epNum: parseInt(match[2]), href });
  });
  return episodes;
}

export async function scrapePelisPediaSeriesDetail(id: string): Promise<ContentDetail | null> {
  const cacheKey = `pelispedia:series:${id}`;
  const cached = memoryCache.get<ContentDetail>(cacheKey);
  if (cached) return cached;

  const slug = id.replace(/^ser_/, '').replace(/_/g, '-');
  const url = `${BASE_URL}/serie/${slug}`;
  const html = await fetchText(url);
  if (!html) return null;

  const $ = cheerio.load(html);
  if (isErrorPage($)) return null;
  const meta = extractMeta($);
  if (!meta) return null;

  const episodes = extractChapters($);
  const seasonMap = new Map<number, Episode[]>();
  const concurrency = 5;
  for (let i = 0; i < episodes.length; i += concurrency) {
    const batch = episodes.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (ep) => {
        const epHtml = await fetchText(ep.href.startsWith('http') ? ep.href : `${BASE_URL}${ep.href}`);
        if (!epHtml) return { ep, videos: [] as VideoLanguage[] };
        const iframeUrl = extractIframeUrl(epHtml);
        if (!iframeUrl) return { ep, videos: [] as VideoLanguage[] };
        const languages = await expandPlayerEmbed(iframeUrl);
        return { ep, videos: Array.from(languages.entries()).map(([language, servers]) => ({ language, servers })) };
      }),
    );
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { ep, videos } = result.value;
      const existing = seasonMap.get(ep.seasonNum) || [];
      existing.push({
        id: `${id}_s${ep.seasonNum}e${ep.epNum}`,
        title: `Capítulo ${ep.epNum}`,
        duration: '45m',
        episode_number: ep.epNum,
        videos: videos.length > 0 ? videos : undefined,
      });
      seasonMap.set(ep.seasonNum, existing);
    }
  }

  const seasons: Season[] = [];
  for (const [seasonNum, epList] of [...seasonMap.entries()].sort(([a], [b]) => a - b)) {
    if (epList.length === 0) continue;
    epList.sort((a, b) => a.episode_number - b.episode_number);
    seasons.push({ season_number: seasonNum, title: `Temporada ${seasonNum}`, episodes: epList });
  }

  const detail: ContentDetail = {
    id,
    title: meta.title,
    description: meta.description,
    poster: meta.poster,
    backdrop: meta.poster,
    rating: meta.rating || 8.0,
    year: meta.year || 2024,
    genres: meta.genres.length > 0 ? meta.genres : ['Drama', 'Acción'],
    cast: [{ name: 'Reparto Principal' }],
    type: 'series',
    seasons: seasons.length > 0 ? seasons : undefined,
  };

  memoryCache.set(cacheKey, detail, 600_000);
  return detail;
}