import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { fetchHTML } from '../utils/http';
import { httpClient } from '../utils/http';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { BannerItem, ContentDetail, DownloadLink, Episode, MediaItem, Season, Section, VideoLanguage } from '../types';
import { storeKeys, getRow, setRow } from '../services/store';

/**
 * Proveedor GNULA HD (https://ww3.gnulahd.nu).
 *
 * WordPress con tema hijo de dramastream (prefijo `gnrd-`). Todo el contenido
 * es server-rendered; el player y las descargas se obtienen de un endpoint
 * REST propio del sitio (`/wp-json/gnrd/v1/player`) que devuelve un payload
 * ofuscado (base64 + XOR con la clave [103,78,55,100] = 'gN7d').
 *
 * IDs: gmov_<slug> (película), gser_<slug> (serie), gani_<slug> (anime).
 */

export const GNULLAHD_BASE_URL = 'https://ww3.gnulahd.nu';

export type GnulahdKind = 'peliculas' | 'series' | 'anime';

export interface GnulahdHomeData {
  banners: BannerItem[];
  sections: Section[];
  updatedAt: number;
}

interface GnrdPlayerData {
  t?: string;
  langs?: { label: string; flag?: string; servers: { title: string; src: string }[] }[];
  dl?: { name: string; lang?: string; qual?: string; url: string }[];
}

const GNRD_XOR_KEY = [103, 78, 55, 100];
const LIST_CACHE_TTL = 10 * 60_000;

/** El DNS del sitio es inestable: reintenta el fetch un par de veces. */
async function fetchGnulahdHTML(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetchHTML(url);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }
  }
  throw lastError;
}

// ---- Helpers de parseo ----

function extractImageUrl(style: string): string | undefined {
  const match = style.match(/url\(['"]?(.*?)['"]?\)/);
  if (!match) return undefined;
  const url = match[1].trim();
  return url && (url.startsWith('http') || url.startsWith('//')) ? url : undefined;
}

function extractSlug(href: string): string {
  const match = href.match(/\/ver\/([^/]+)\/?$/);
  return match ? match[1] : '';
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function parseRating(text: string): number | undefined {
  const match = text.replace(/★/g, '').match(/([\d.]+)/);
  if (!match) return undefined;
  const value = parseFloat(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

type GnulahdMediaType = 'movie' | 'series' | 'anime';

function typeFromTitle(title: string): GnulahdMediaType {
  const t = title.toLowerCase();
  if (t.includes('anime')) return 'anime';
  if (t.includes('serie')) return 'series';
  return 'movie';
}

function typeFromBadge($el: cheerio.Cheerio<AnyNode>, fallback: GnulahdMediaType): GnulahdMediaType {
  const badge = $el.find('.gnrd-type-badge').first().text().trim().toLowerCase();
  if (!badge) return fallback;
  if (badge.includes('anime')) return 'anime';
  if (badge.includes('serie')) return 'series';
  return 'movie';
}

/** Corrige registros antiguos cuyo prefijo no coincide con el tipo real. */
export function normalizeGnulahdItemId<T extends { id: string; type: 'movie' | 'series' | 'anime' | 'live' }>(item: T): T {
  if (item.type === 'live') return item;
  const slug = item.id.replace(/^(?:gmov_|gser_|gani_)/, '');
  const prefix = item.type === 'anime'
    ? 'gani_'
    : item.type === 'series'
    ? (item.id.startsWith('gani_') ? 'gani_' : 'gser_')
    : 'gmov_';
  const id = `${prefix}${slug}`;
  return id === item.id ? item : { ...item, id };
}

/** Card de listado/fila: `a.gnrd-card` con `.gnrd-card-art img`, rating, langs, etc. */
function parseGnrdCard(
  $: cheerio.CheerioAPI,
  el: AnyNode,
  opts: { type: GnulahdMediaType; prefix: string },
): MediaItem | null {
  const $el = $(el);
  const href = $el.attr('href') || '';
  const slug = extractSlug(href);
  if (!slug) return null;

  const type = typeFromBadge($el, opts.type);
  // El badge de la tarjeta tiene prioridad sobre el tipo de la sección:
  // algunas filas de GNULA mezclan películas y series.
  const prefix = type === 'anime' ? 'gani_' : type === 'series' ? 'gser_' : 'gmov_';

  const title = $el.attr('title')?.trim() || $el.find('.gnrd-card-title').first().text().trim();
  if (!title) return null;

  const poster = $el.find('.gnrd-card-art img').first().attr('src') || $el.find('img').first().attr('src');
  const rating = parseRating($el.find('.gnrd-rating').first().text());
  const yearText = $el.find('.gnrd-card-metaline span').last().text().trim();
  const year = parseInt(yearText) || undefined;
  const genresText = $el.find('.gnrd-card-genres').first().text().trim();

  const item: MediaItem = {
    id: `${prefix}${slug}`,
    title,
    poster: poster || undefined,
    rating,
    year,
    type,
  };
  if (genresText) {
    item.genres = genresText
      .split(/[•·|]/)
      .map((g) => g.trim())
      .filter(Boolean);
  }
  return item;
}

// ---- Player / descargas ----

/** Decodifica el payload ofuscado del player (atob -> XOR 'gN7d' -> utf8). */
export function gnrdUnpack(payload: string): GnrdPlayerData {
  try {
    const buf = Buffer.from(payload, 'base64');
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
      out[i] = buf[i] ^ GNRD_XOR_KEY[i % GNRD_XOR_KEY.length];
    }
    const parsed = JSON.parse(out.toString('utf8')) as GnrdPlayerData;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function extractPlayerVars(html: string): { pid: number; tok: string } | null {
  const match = html.match(/_gnrdPid=(\d+),\s*_gnrdTok="([a-f0-9]+)"/);
  if (!match) return null;
  return { pid: parseInt(match[1], 10), tok: match[2] };
}

async function fetchGnrdPlayer(pid: number, tok: string, referer: string): Promise<GnrdPlayerData> {
  const url = `${GNULLAHD_BASE_URL}/wp-json/gnrd/v1/player?id=${pid}&t=${encodeURIComponent(tok)}`;
  try {
    const response = await httpClient.get(url, {
      headers: { Referer: referer, 'X-Requested-With': 'XMLHttpRequest' },
      timeout: 20000,
    });
    const body = response.data as { p?: string };
    if (!body || typeof body.p !== 'string') return {};
    return gnrdUnpack(body.p);
  } catch (error) {
    logger.warn({ error: (error as Error).message, pid }, 'Gnulahd player API failed');
    return {};
  }
}

function toVideoLanguages(data: GnrdPlayerData): VideoLanguage[] {
  if (!Array.isArray(data.langs)) return [];
  return data.langs
    .filter((l) => l && l.label && Array.isArray(l.servers))
    .map((l) => ({
      language: l.label,
      servers: l.servers
        .filter((s) => s && s.src)
        .map((s) => ({ name: s.title || 'Servidor', url: s.src })),
    }))
    .filter((l) => l.servers.length > 0);
}

function toDownloadLinks(data: GnrdPlayerData): DownloadLink[] {
  if (!Array.isArray(data.dl)) return [];
  return data.dl
    .filter((d) => d && d.name && d.url)
    .map((d) => ({ name: d.name, url: d.url, lang: d.lang, quality: d.qual }));
}

// ---- Home ----

function parseHeroSlide($: cheerio.CheerioAPI, el: AnyNode): BannerItem | null {
  const $el = $(el);
  const backdrop = extractImageUrl($el.find('.gnrd-hero-bg').first().attr('style') || '');
  if (!backdrop) return null;

  const eyebrow = $el.find('.gnrd-eyebrow').first().text().trim().toLowerCase();
  const isAnime = eyebrow.includes('anime');
  const isSeries = eyebrow.includes('serie') || isAnime;
  const type: 'movie' | 'series' | 'anime' = isAnime ? 'anime' : isSeries ? 'series' : 'movie';

  const title = $el.find('.gnrd-hero-logo').first().attr('alt')?.trim() || $el.find('.gnrd-hero-title').first().text().trim();
  if (!title) return null;

  const href = $el.find('a.gnrd-btn-play').first().attr('href') || '';
  const slug = extractSlug(href) || slugify(title);
  const prefix = type === 'anime' ? 'gani_' : type === 'movie' ? 'gmov_' : 'gser_';

  const rating = parseRating($el.find('.gnrd-m-rating').first().text());
  const metaSpans = $el
    .find('.gnrd-hero-meta > span:not(.gnrd-m-rating)')
    .map((_, s) => $(s).text().trim())
    .get();
  const year = parseInt(metaSpans[0] || '') || undefined;
  const genres = $el
    .find('.gnrd-hero-meta .gnrd-genre')
    .map((_, g) => $(g).text().trim())
    .get();
  const synopsis = $el.find('.gnrd-hero-syn').first().text().trim();
  const logo = $el.find('.gnrd-hero-logo').first().attr('src');

  const banner: BannerItem = {
    id: `${prefix}${slug}`,
    title,
    image: backdrop,
    backdrop,
    poster: logo || undefined,
    rating,
    year,
    type,
    genres: genres.length > 0 ? genres : undefined,
  };
  if (synopsis) banner.description = synopsis;
  return banner;
}

function parseHomeRow($: cheerio.CheerioAPI, el: AnyNode): Section | null {
  const $el = $(el);
  const title = $el.find('.gnrd-row-head h2').first().text().trim();
  if (!title) return null;

  const titleType = typeFromTitle(title);
  const sectionType: 'movies' | 'series' | 'anime' = titleType === 'anime' ? 'anime' : titleType === 'series' ? 'series' : 'movies';
  const prefix = titleType === 'anime' ? 'gani_' : titleType === 'series' ? 'gser_' : 'gmov_';

  const items: MediaItem[] = [];
  $el.find('.gnrd-rail > a.gnrd-card').each((_, card) => {
    const item = parseGnrdCard($, card, { type: titleType, prefix });
    if (item) items.push(item);
  });
  if (items.length === 0) return null;

  return {
    title,
    type: sectionType,
    items,
    seeAllRoute: $el.find('.gnrd-row-head a.gnrd-viewall').first().attr('href') || '',
    totalItems: items.length,
  };
}

export async function scrapeGnulahdHome(): Promise<GnulahdHomeData> {
  const html = await fetchGnulahdHTML(`${GNULLAHD_BASE_URL}/`);
  const $ = cheerio.load(html);

  const banners: BannerItem[] = [];
  $('#gnrdHero .gnrd-slide').each((_, el) => {
    const banner = parseHeroSlide($, el);
    if (banner) banners.push(banner);
  });

  const sections: Section[] = [];
  $('section.gnrd-row').each((_, el) => {
    const section = parseHomeRow($, el);
    if (section) sections.push(section);
  });

  logger.info({ banners: banners.length, sections: sections.length }, 'Gnulahd home scraped');
  return { banners, sections, updatedAt: Date.now() };
}

export async function saveGnulahdHomeData(data: GnulahdHomeData): Promise<void> {
  await setRow(storeKeys.gnulahdHome, { ...data, updatedAt: Date.now() });
}

export async function loadGnulahdHomeData(): Promise<GnulahdHomeData | null> {
  const data = await getRow<GnulahdHomeData>(storeKeys.gnulahdHome);
  if (!data) return null;
  return {
    ...data,
    banners: data.banners.map(normalizeGnulahdItemId),
    sections: data.sections.map((section) => ({
      ...section,
      items: section.items.map(normalizeGnulahdItemId),
    })),
  };
}

// ---- Listados ----

export async function scrapeGnulahdList(
  kind: GnulahdKind,
  page = 1,
): Promise<{ items: MediaItem[]; totalPages: number; totalItems: number }> {
  const cacheKey = `gnulahd:list:${kind}:${page}`;
  const cached = memoryCache.get<{ items: MediaItem[]; totalPages: number; totalItems: number }>(cacheKey);
  if (cached) return cached;

  const url = page > 1 ? `${GNULLAHD_BASE_URL}/ver/${kind}?page=${page}` : `${GNULLAHD_BASE_URL}/ver/${kind}`;
  const html = await fetchGnulahdHTML(url);
  const $ = cheerio.load(html);

  const type: GnulahdMediaType = kind === 'peliculas' ? 'movie' : kind === 'anime' ? 'anime' : 'series';
  const prefix = kind === 'peliculas' ? 'gmov_' : kind === 'series' ? 'gser_' : 'gani_';

  const items: MediaItem[] = [];
  $('.gnrd-grid > a.gnrd-card').each((_, el) => {
    const item = parseGnrdCard($, el, { type, prefix });
    if (item) items.push(item);
  });

  const pageNums: number[] = [];
  $('nav.gnrd-pg-seo .page-numbers').each((_, el) => {
    const text = $(el).text().trim();
    const num = parseInt(text, 10);
    if (!isNaN(num) && text === String(num)) pageNums.push(num);
  });
  const totalPages = pageNums.length > 0 ? Math.max(...pageNums) : 1;
  const totalItems = items.length > 0 ? totalPages * items.length : 0;

  const result = { items, totalPages, totalItems };
  memoryCache.set(cacheKey, result, LIST_CACHE_TTL);
  return result;
}

// ---- Búsqueda ----

export async function searchGnulahd(query: string): Promise<{ items: MediaItem[]; total: number }> {
  const cacheKey = `gnulahd:search:${query}`;
  const cached = memoryCache.get<{ items: MediaItem[]; total: number }>(cacheKey);
  if (cached) return cached;

  const url = `${GNULLAHD_BASE_URL}/?s=${encodeURIComponent(query)}`;
  const html = await fetchGnulahdHTML(url);
  const $ = cheerio.load(html);

  const items: MediaItem[] = [];
  $('.gnrd-grid > a.gnrd-card').each((_, el) => {
    const $el = $(el);
    const badge = $el.find('.gnrd-type-badge').first().text().trim().toLowerCase();
    const isAnime = badge.includes('anime');
    const isSeries = badge.includes('serie') || isAnime;
    const item = parseGnrdCard($, el, {
      type: isAnime ? 'anime' : isSeries ? 'series' : 'movie',
      prefix: isAnime ? 'gani_' : isSeries ? 'gser_' : 'gmov_',
    });
    if (item) items.push(item);
  });

  const result = { items, total: items.length };
  memoryCache.set(cacheKey, result, LIST_CACHE_TTL);
  return result;
}

// ---- Detalle ----

function parseDetailCast($: cheerio.CheerioAPI): { name: string; character?: string }[] {
  try {
    const cast: { name: string; character?: string }[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).text().trim();
      if (!raw) return;
      const data = JSON.parse(raw);
      const graph = Array.isArray(data) ? data : data['@graph'] || [data];
      for (const node of graph) {
        const castNodes = Array.isArray(node.actor) ? node.actor : node.actor ? [node.actor] : [];
        for (const actor of castNodes) {
          if (actor && actor.name) {
            cast.push({ name: actor.name, character: actor.characterName || actor.character?.name || undefined });
          }
        }
      }
    });
    return cast.slice(0, 15);
  } catch {
    return [];
  }
}

function parseEpisodes($: cheerio.CheerioAPI, seriesId: string): { season: number; episode: Episode; url: string }[] {
  const parsed: { season: number; episode: Episode; url: string }[] = [];
  $('.gnrd-epc').each((_, el) => {
    const $el = $(el);
    const season = parseInt($el.attr('data-s') || '', 10);
    const epNum = parseInt($el.attr('data-e') || '', 10);
    if (isNaN(season) || isNaN(epNum)) return;
    const href = $el.attr('href') || '';
    const title = $el.find('.gnrd-epc-title').first().text().trim() || $el.find('.gnrd-epc-n').first().text().trim();
    if (!title) return;
    const thumbnail = extractImageUrl($el.find('.gnrd-epc-thumb').first().attr('style') || '');
    const episode: Episode = {
      id: `${seriesId}_s${season}e${epNum}`,
      title,
      duration: $el.find('.gnrd-epc-dur').first().text().trim() || '45m',
      description: $el.find('.gnrd-epc-ov').first().text().trim() || undefined,
      thumbnail,
      episode_number: epNum,
    };
    parsed.push({ season, episode, url: href });
  });
  return parsed;
}

async function fillEpisodeVideos(parsed: { season: number; episode: Episode; url: string }[]): Promise<void> {
  for (let i = 0; i < parsed.length; i += 5) {
    const batch = parsed.slice(i, i + 5);
    await Promise.allSettled(
      batch.map(async (entry) => {
        try {
          const html = await fetchGnulahdHTML(entry.url);
          const vars = extractPlayerVars(html);
          if (!vars) return;
          const player = await fetchGnrdPlayer(vars.pid, vars.tok, entry.url);
          const videos = toVideoLanguages(player);
          if (videos.length > 0) entry.episode.videos = videos;
        } catch {
          /* episodio sin player: se omite */
        }
      }),
    );
  }
}

function buildSeasons(parsed: { season: number; episode: Episode }[]): Season[] {
  const map = new Map<number, Episode[]>();
  for (const entry of parsed) {
    if (!map.has(entry.season)) map.set(entry.season, []);
    map.get(entry.season)!.push(entry.episode);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([seasonNumber, episodes]) => ({
      season_number: seasonNumber,
      title: `Temporada ${seasonNumber}`,
      episodes: episodes.sort((a, b) => a.episode_number - b.episode_number),
    }));
}

export async function scrapeGnulahdDetail(id: string): Promise<ContentDetail | null> {
  const prefix = id.startsWith('gmov_') ? 'gmov_' : id.startsWith('gser_') ? 'gser_' : id.startsWith('gani_') ? 'gani_' : '';
  if (!prefix) return null;
  const isSeries = prefix !== 'gmov_';
  const slug = id.slice(prefix.length);
  const url = `${GNULLAHD_BASE_URL}/ver/${slug}/`;

  const html = await fetchGnulahdHTML(url);
  const $ = cheerio.load(html);
  if ($('body').text().trim().length < 200) return null;

  const title =
    $('.gnrd-fi-title .gnrd-sr').first().text().trim() ||
    $('.gnrd-fi-title').first().clone().children().remove().end().text().trim() ||
    $('.gnrd-fi-logo').first().attr('alt')?.trim() ||
    $('.gnrd-fi-title').first().text().trim();
  if (!title) return null;

  const backdrop = extractImageUrl($('.gnrd-fi-bg').first().attr('style') || '');
  const poster = $('meta[itemprop="image"]').first().attr('content');

  const ratingMeta = $('meta[itemprop="ratingValue"]').first().attr('content');
  const rating = ratingMeta ? parseFloat(ratingMeta) : parseRating($('.gnrd-m-rating').first().text()) || 0;

  const metaSpans = $('.gnrd-fi-meta > span:not(.gnrd-m-rating)')
    .map((_, s) => $(s).text().trim())
    .get();
  const year = parseInt(metaSpans[0] || '', 10) || 0;
  const duration = metaSpans[1] || undefined;
  const country = metaSpans[2] || undefined;

  const genres = $('.gnrd-fi-genres a')
    .map((_, g) => $(g).text().trim())
    .get();
  const description = $('#gnrd-syn').first().text().trim() || title;
  const cast = parseDetailCast($);

  const detail: ContentDetail = {
    id,
    title,
    description,
    backdrop: backdrop || poster,
    poster,
    rating: rating || 7.0,
    year: year || 2024,
    duration,
    country,
    genres: genres.length > 0 ? genres : ['Acción'],
    cast: cast.length > 0 ? cast : [{ name: 'Reparto Principal' }],
    type: prefix === 'gani_' ? 'anime' : isSeries ? 'series' : 'movie',
  };

  const vars = extractPlayerVars(html);
  if (vars) {
    const player = await fetchGnrdPlayer(vars.pid, vars.tok, url);
    const videos = toVideoLanguages(player);
    const downloads = toDownloadLinks(player);
    if (videos.length > 0) detail.videos = videos;
    if (downloads.length > 0) detail.downloads = downloads;
  }

  if (isSeries) {
    const parsed = parseEpisodes($, id);
    if (parsed.length > 0) {
      await fillEpisodeVideos(parsed);
      detail.seasons = buildSeasons(parsed);
    }
  }

  logger.info({ id, title, videos: detail.videos?.length || 0, seasons: detail.seasons?.length || 0 }, 'Gnulahd detail scraped');
  return detail;
}
