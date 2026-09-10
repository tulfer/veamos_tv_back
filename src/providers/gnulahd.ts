import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { fetchHTMLWithCookies, cookieHeader } from '../utils/http';
import { httpClient } from '../utils/http';
import { logger } from '../utils/logger';
import { isUnsupportedVideoHost } from '../utils/unsupported-video-hosts';
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

/** Dominios oficiales de GNULA (mismo sitio, distintos hostnames). El primero
 *  es el preferido; el resto se usan como respaldo si el principal no responde. */
export const GNULLAHD_STATIC_DOMAINS = ['https://ww3.gnulahd.nu', 'https://gnulahd.click', 'https://gnulahd.bid'] as const;

/** Se mantiene por compatibilidad (equivalente al dominio preferido). */
export const GNULLAHD_BASE_URL = GNULLAHD_STATIC_DOMAINS[0];

const ACTIVE_DOMAIN_TTL = 10 * 60_000;
const DISCOVER_TTL_MS = 6 * 60 * 60 * 1000;

let activeBase: string | null = null;
let activeBaseExpires = 0;
let discoveredDomains: string[] = [];
let discoveredAt = 0;

function normalizeGnulahdDomain(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

/** Descubre dominios oficiales desde dominiosgnulahd.com (best effort, cacheado
 *  6 h). Si la página no responde, se usan solo los dominios estáticos. */
async function discoverGnulahdDomains(): Promise<string[]> {
  if (discoveredDomains.length > 0 && Date.now() - discoveredAt < DISCOVER_TTL_MS) return discoveredDomains;
  const found: string[] = [];
  try {
    const response = await httpClient.get('https://dominiosgnulahd.com', { timeout: 12000 });
    const html = response.data as string;
    // Las "puertas" son <a class="door" href="https://.../">; algunas pueden
    // apuntar a otros esquemas/subdominios que el propio sitio lista.
    const re = /href="(https:\/\/[a-z0-9.-]+(?::\d+)?\/?)"/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
      const domain = normalizeGnulahdDomain(match[1]);
      if (domain && /gnulahd\./i.test(domain) && !found.includes(domain)) found.push(domain);
    }
  } catch {
    /* sin descubrimiento: se usan los dominios estáticos */
  }
  discoveredDomains = found;
  discoveredAt = Date.now();
  return discoveredDomains;
}

/** Lista completa de dominios candidatos (estáticos + descubiertos), sin duplicados. */
async function getGnulahdDomains(): Promise<string[]> {
  const discovered = await discoverGnulahdDomains();
  const list: string[] = [];
  for (const raw of [...GNULLAHD_STATIC_DOMAINS, ...discovered]) {
    const domain = normalizeGnulahdDomain(raw);
    if (domain && !list.includes(domain)) list.push(domain);
  }
  return list;
}

/** Devuelve la base activa, validando los dominios cuando la caché venció o al
 *  arrancar (proceso nuevo). Ante un fallo del activo se prueba el siguiente. */
async function getGnulahdBase(force = false): Promise<string> {
  if (!force && activeBase && Date.now() < activeBaseExpires) return activeBase;

  // Arranque/proceso nuevo: reutilizar el último dominio bueno persistido
  if (!force && !activeBase) {
    const stored = await getRow<string>('gnulahd:domain');
    if (stored && (GNULLAHD_STATIC_DOMAINS as readonly string[]).includes(stored)) {
      activeBase = stored;
      activeBaseExpires = Date.now() + 30_000;
      return stored;
    }
  }

  const domains = await getGnulahdDomains();
  for (const base of domains) {
    try {
      const html = await fetchHTMLWithCookies(`${base}/`);
      if (isGnulahdHTMLUsable(html)) {
        activeBase = base;
        activeBaseExpires = Date.now() + ACTIVE_DOMAIN_TTL;
        void setRow('gnulahd:domain', base).catch(() => {});
        return base;
      }
      // Interstitial de DDoS-Guard en el dominio: intentar obtener el pase.
      if (/gnm=1|ddos-guard|__ddg/i.test(html)) {
        await fetchHTMLWithCookies(`${base}/?gnm=1`, `${base}/`);
        const again = await fetchHTMLWithCookies(`${base}/`);
        if (isGnulahdHTMLUsable(again)) {
          activeBase = base;
          activeBaseExpires = Date.now() + ACTIVE_DOMAIN_TTL;
          void setRow('gnulahd:domain', base).catch(() => {});
          return base;
        }
      }
    } catch {
      /* siguiente dominio */
    }
  }
  // Ninguno respondió: usar el preferido y volver a validar pronto.
  activeBase = GNULLAHD_STATIC_DOMAINS[0];
  activeBaseExpires = Date.now() + 30_000;
  return activeBase;
}

export type GnulahdKind = 'peliculas' | 'series' | 'anime';

export interface GnulahdHomeData {
  banners: BannerItem[];
  sections: Section[];
  updatedAt: number;
}

interface GnrdPlayerData {
  t?: string;
  /** GNULA devuelve `langs` como objeto clave→idioma (p.ej. {lat:{label:'Latino',...}}) */
  langs?: Record<string, { label: string; flag?: string; servers: { title: string; src: string }[] }>;
  dl?: { name: string; lang?: string; qual?: string; url: string }[];
}

const GNRD_XOR_KEY = [103, 78, 55, 100];
const LIST_CACHE_TTL = 10 * 60_000;
/** Episodios máximos por serie que se resuelven durante un sync (el resto se
 *  resuelve bajo demanda al abrir el título). Evita que series de cientos de
 *  episodios bloqueen el prefetch del home. */
const MAX_EPISODES_SCRAPE = 60;

/** Una respuesta 200 pero vacía/corta o sin los marcadores de GNULA suele ser
 *  un challenge anti-bot o bloqueo del datacenter (no un catálogo vacío de
 *  verdad). Se trata como error para que los reintentos/backoff actúen y no se
 *  cachee un "0 items" falso. */
function isGnulahdHTMLUsable(html: string): boolean {
  const text = html.trim();
  if (text.length < 10_000) return false;
  // El HTML de GNULA siempre incluye estos marcadores; un challenge no.
  return /gnrd-card|gnrdHero|gnrd-grid|gnrd-pg-seo|wp-content/i.test(text);
}

/** El sitio está tras DDoS-Guard: a veces responde el interstitial (HTML corto
 *  que redirige a /?gnm=1) y a veces el contenido real. Reintenta varias veces
 *  con backoff, y si detecta el interstitial intenta "pasar" haciendo /?gnm=1
 *  con las cookies que DDoS-Guard deja en la primera respuesta. */
async function fetchGnulahdHTMLFromHost(base: string, pathAndQuery: string, referer?: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      let html = await fetchHTMLWithCookies(`${base}${pathAndQuery}`, referer);
      if (isGnulahdHTMLUsable(html)) return html;

      // Interstitial de DDoS-Guard: visitar /?gnm=1 con las cookies para
      // obtener el pase y reintentar la URL original.
      if (html.includes('gnm=1') || /ddos-guard|__ddg/i.test(html)) {
        await fetchHTMLWithCookies(`${base}/?gnm=1`, `${base}${pathAndQuery}`);
        html = await fetchHTMLWithCookies(`${base}${pathAndQuery}`);
        if (isGnulahdHTMLUsable(html)) return html;
      }

      lastError = new Error('HTML de GNULA no utilizable (posible anti-bot o vacío)');
      if (attempt >= 4) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
  }
  throw lastError;
}

/** Fetch de páginas GNULA con respaldo de dominios: si el dominio que sirve la
 *  URL falla (anti-bot, bloqueo, DNS), se reintenta el mismo path en los demás
 *  dominios oficiales y se promueve el que responda. */
async function fetchGnulahdHTML(url: string): Promise<string> {
  const parsed = new URL(url);
  const preferred = `${parsed.protocol}//${parsed.host}`;
  const pathAndQuery = parsed.pathname + parsed.search;

  const candidates: string[] = [];
  for (const base of [preferred, ...(await getGnulahdDomains())]) {
    const normalized = normalizeGnulahdDomain(base);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  }

  let lastError: unknown;
  for (const base of candidates) {
    try {
      const html = await fetchGnulahdHTMLFromHost(base, pathAndQuery, preferred);
      if (base !== preferred && candidates.indexOf(base) > 0) {
        // El dominio pedido dejó de responder: promover el que sí funcionó
        activeBase = base;
        activeBaseExpires = Date.now() + ACTIVE_DOMAIN_TTL;
        void setRow('gnulahd:domain', base).catch(() => {});
        logger.warn({ preferred, promovido: base }, 'Gnulahd: dominio promovido tras fallo del principal');
      }
      return html;
    } catch (error) {
      lastError = error;
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

/** Corrige registros antiguos cuyo prefijo no coincide con el tipo real.
 *  Si el item no trae `type` (caso de las cards sincronizadas v2, que solo
 *  marcan `anime`), se conserva el prefijo que ya trae el id. */
export function normalizeGnulahdItemId<T extends { id: string; type?: 'movie' | 'series' | 'anime' | 'live' }>(item: T): T {
  if (item.type === 'live') return item;
  const slug = item.id.replace(/^(?:gmov_|gser_|gani_)/, '');
  const existing = item.id.match(/^(gmov_|gser_|gani_)/)?.[1] || '';
  const prefix = item.type === 'anime'
    ? 'gani_'
    : item.type === 'series'
    ? (item.id.startsWith('gani_') ? 'gani_' : 'gser_')
    : item.type === 'movie'
    ? 'gmov_'
    : existing;
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
  const url = `${await getGnulahdBase()}/wp-json/gnrd/v1/player?id=${pid}&t=${encodeURIComponent(tok)}`;
  const cacheKey = `gnrd:player:${url}`;
  const cached = memoryCache.get<GnrdPlayerData>(cacheKey);
  if (cached) return cached;

  const attempt = async (): Promise<GnrdPlayerData> => {
    const response = await httpClient.get(url, {
      headers: {
        Referer: referer,
        'X-Requested-With': 'XMLHttpRequest',
        ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
      },
      timeout: 12000,
    });
    const body = response.data as { p?: string };
    if (!body || typeof body.p !== 'string') return {};
    return gnrdUnpack(body.p);
  };

  try {
    const data = await attempt();
    if (Object.keys(data).length > 0) {
      memoryCache.set(cacheKey, data, 120_000);
    }
    return data;
  } catch (error) {
    // Un 502/red puede ser rate-limit puntual: un reintento tras ~700ms suele
    // pasar. Si vuelve a fallar, se devuelve vacío (el caller continúa).
    logger.warn({ error: (error as Error).message, pid }, 'Gnulahd player API failed, reintentando...');
    try {
      return await attempt();
    } catch (error2) {
      logger.warn({ error: (error2 as Error).message, pid }, 'Gnulahd player API failed');
      return {};
    }
  }
}

function toVideoLanguages(data: GnrdPlayerData): VideoLanguage[] {
  const raw = data.langs;
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list
    .filter((l) => l && l.label && Array.isArray(l.servers))
    .map((l) => ({
      language: l.label,
      servers: l.servers
        .filter((s) => s && s.src && !isUnsupportedVideoHost(s.src))
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
  const html = await fetchGnulahdHTML(`${await getGnulahdBase()}/`);
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

  // Un home sin banners ni secciones indica que el HTML fue un anti-bot o
  // quedó vacío; no debe sobrescribir el home existente con vacío.
  if (banners.length === 0 && sections.length === 0) {
    throw new Error('Gnulahd home sin banners ni secciones (anti-bot o vacío)');
  }
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

  const base = await getGnulahdBase();
  const url = page > 1 ? `${base}/ver/${kind}?page=${page}` : `${base}/ver/${kind}`;
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

  const url = `${await getGnulahdBase()}/?s=${encodeURIComponent(query)}`;
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
  // Límite por serie en el sync: las series largas (p.ej. 1000 episodios)
  // bloquearían el prefetch del home. Solo se resuelven los primeros N
  // episodios; el resto se resuelve bajo demanda al abrir el título
  // (getGnulahdDetailContent → heal on read).
  const limit = Math.min(parsed.length, MAX_EPISODES_SCRAPE);
  const limited = parsed.slice(0, limit);
  // Concurrencia 2 + delay: la player API de GNULA responde 502 cuando se
  // martilla con requests en paralelo (rate-limit por IP de datacenter).
  for (let i = 0; i < limited.length; i += 2) {
    const batch = limited.slice(i, i + 2);
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
    if (i + 2 < limited.length) {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
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
  const url = `${await getGnulahdBase()}/ver/${slug}/`;

  let html: string;
  try {
    html = await fetchGnulahdHTML(url);
  } catch {
    // 404/timeout: el ítem no existe en GNULA (p.ej. ids de PelisPlus/
    // PelisPedia con slug con guiones bajos); el caller debe continuar
    // con los proveedores de respaldo.
    return null;
  }
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
