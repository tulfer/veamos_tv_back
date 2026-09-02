import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { fetchHTML } from '../utils/http';
import { Episode, Season, VideoLanguage, VideoServer, MediaItem } from '../types';
import { isUnsupportedVideoHost } from '../utils/unsupported-video-hosts';
import { logger } from '../utils/logger';

const BASE_URL = 'https://latanime.org';

function absoluteUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function episodeNumber(value: string): number | null {
  const named = value.match(/(?:episode|episodio|cap[ií]tulo)[^\d]{0,8}(\d+)/i);
  if (named) return Number(named[1]);
  const trailing = value.match(/(?:-|\/)(\d+)(?:\D*)$/);
  return trailing ? Number(trailing[1]) : null;
}

function extractServers($: cheerio.CheerioAPI, pageUrl: string): VideoLanguage[] {
  const servers: VideoServer[] = [];
  const seen = new Set<string>();
  const streamingNames = /dsvplay|byse|hexload|savefiles|mega|mixdrop|voe|mp4upload|streamtape|filemoon|doodstream|streamwish|filelions/i;
  const add = (raw: string | undefined, name?: string) => {
    const url = raw ? absoluteUrl(raw.trim(), pageUrl) : null;
    if (!url || seen.has(url) || isUnsupportedVideoHost(url)) return;
    try {
      if (new URL(url).hostname === 'latanime.org') return;
    } catch { return; }
    seen.add(url);
    servers.push({ name: name?.trim() || `Servidor ${servers.length + 1}`, url });
  };

  $('[data-url],[data-src],[data-video],[data-link],[data-embed],[data-iframe], iframe[src], video source[src]').each((_, element) => {
    const $element = $(element);
    add($element.attr('data-url') || $element.attr('data-src') || $element.attr('data-video') || $element.attr('data-link') || $element.attr('data-embed') || $element.attr('data-iframe') || $element.attr('src'), $element.text());
  });
  $('[data-player]').each((_, element) => {
    const $element = $(element);
    const raw = ($element.attr('data-player') || '').trim();
    if (!raw) return;
    let decoded = raw;
    if (raw.length > 20 && /^[A-Za-z0-9+/=]+$/.test(raw)) {
      try {
        const buffered = Buffer.from(raw, 'base64').toString('utf8');
        if (/^https?:\/\//.test(buffered)) decoded = buffered;
      } catch { /* no base64 válido */ }
    }
    const label = $element.text().trim();
    if (/^(descargar|download)/i.test(label) || /mega\.nz|mediafire|gofile|1cloudfile/i.test(decoded)) return;
    add(decoded, label);
  });
  $('[onclick], .server-list a[href], .servers a[href], .video-servers a[href], [class*="server"] a[href], [id*="server"] a[href]').each((_, element) => {
    const $element = $(element);
    const href = $element.attr('href') || '';
    const onclick = $element.attr('onclick') || '';
    if (/descarg|download|mediafire|gofile/i.test(`${$element.text()} ${$element.attr('class') || ''} ${$element.parent().text()}`)) return;
    const eventUrl = onclick.match(/https?:[^'"\s)]+/i)?.[0];
    if (/\.(?:jpg|jpeg|png|gif|css|js)(?:\?|$)/i.test(href)) return;
    if (streamingNames.test($element.text()) || eventUrl || href.startsWith('http')) {
      add(eventUrl || href || $element.attr('data-url') || $element.attr('data-src') || $element.attr('data-video'), $element.text());
    }
  });
  return servers.length ? [{ language: 'Latino', servers }] : [];
}

/** Parsea la página de detalle de un anime de latanime.org: detecta los
 *  enlaces de episodios y extrae los servidores (latino) de cada uno. Devuelve
 *  también el título real (subtítulo en h3, o el h2 de la página). */
async function parseLatanimeDetail(detailUrl: string, slug: string, onLog?: (message: string) => void): Promise<{ title?: string; seasons: Season[] } | null> {
  const html = await fetchHTML(detailUrl);
  const $ = cheerio.load(html);
  const h3 = $('h3').map((_, el) => $(el).text().trim()).get().find((text) => text && !/cap[ií]tulos?/i.test(text));
  const h2 = $('h2').first().text().trim();
  const ogTitle = ($('meta[property="og:title"]').first().attr('content') || '').replace(/\s*[—|–|-]\s*Latanime\s*$/i, '').trim();
  const title = h3 || h2 || ogTitle || undefined;
  const links = new Map<number, string>();
  $('a[href]').each((_, element) => {
    const href = absoluteUrl($(element).attr('href') || '', detailUrl);
    if (!href || new URL(href).hostname !== 'latanime.org') return;
    const text = `${$(element).text()} ${href}`;
    const number = episodeNumber(text);
    if (number && number > 0 && !links.has(number)) links.set(number, href);
  });
  onLog?.(`Latanime: ${links.size} enlaces de episodios detectados`);

  const episodes: Episode[] = [];
  if (links.size === 0) {
    const videos = extractServers($, detailUrl);
    if (videos.length) episodes.push({ id: `${slug}_e1`, title: 'Episodio 1', duration: '45m', episode_number: 1, videos });
  } else {
    for (const [number, url] of [...links.entries()].sort(([a], [b]) => a - b)) {
      try {
        const episodeHtml = await fetchHTML(url);
        const episodeVideos = extractServers(cheerio.load(episodeHtml), url);
        onLog?.(`Latanime: episodio ${number}, ${episodeVideos.reduce((total, language) => total + language.servers.length, 0)} servidores`);
        if (episodeVideos.length) episodes.push({ id: `${slug}_e${number}`, title: `Episodio ${number}`, duration: '45m', episode_number: number, videos: episodeVideos });
      } catch { /* episodio no disponible */ }
    }
  }
  onLog?.(`Latanime: ${episodes.length} episodios con videos`);
  return episodes.length ? { ...(title ? { title } : {}), seasons: [{ season_number: 1, title: 'Temporada 1', episodes }] } : null;
}

export async function scrapeLatanimeDetail(slug: string, onLog?: (message: string) => void, knownSlug?: string, searchTitle?: string): Promise<{ title?: string; seasons: Season[] } | null> {
  try {
    // El slug conocido (calendario/emisión/catálogo) se intenta directo y, si
    // no hay episodios ahí, se cae a la búsqueda por título.
    if (knownSlug) {
      try {
        const direct = await parseLatanimeDetail(`${BASE_URL}/anime/${knownSlug}`, slug, onLog);
        if (direct) return direct;
        onLog?.(`Latanime: ${knownSlug} sin episodios, buscando por título...`);
      } catch {
        onLog?.(`Latanime: ${knownSlug} no disponible, buscando por título...`);
      }
    }
    let detailUrl: string | null = null;
    const query = (searchTitle || slug).replace(/[\s_-]+/g, '+');
    const searchUrl = `${BASE_URL}/buscar?q=${query}`;
    onLog?.(`Latanime: consultando búsqueda ${searchUrl}`);
    const searchHtml = await fetchHTML(searchUrl);
    const search = cheerio.load(searchHtml);
    search('a[href]').each((_, element) => {
      if (detailUrl) return;
      const href = absoluteUrl(search(element).attr('href') || '', `${BASE_URL}/buscar`);
      if (href && new URL(href).hostname === 'latanime.org' && /\/anime\//i.test(new URL(href).pathname)) detailUrl = href;
    });
    if (!detailUrl) {
      onLog?.('Latanime: no se encontró resultado en la búsqueda');
      return null;
    }
    onLog?.(`Latanime: resultado encontrado ${detailUrl}`);
    return await parseLatanimeDetail(detailUrl, slug, onLog);
  } catch (error) {
    onLog?.(`Latanime: error ${(error as Error).message}`);
    return null;
  }
}

function seasonFromTitle(title: string, slug: string): string {
  const text = `${slug} ${title}`.toLowerCase();
  const match = text.match(/temporada[- ]?(\d+)|(?:^|[-\s])s(\d{1,2})(?:[- ]|$)|(\d+)ª\s*temporada/);
  if (!match) return 'En emisión';
  const n = match[1] || match[2] || match[3];
  return n ? `Temporada ${n}` : 'En emisión';
}

function parseAnimeCards($: cheerio.CheerioAPI, scope: cheerio.Cheerio<AnyNode>): MediaItem[] {
  const items: MediaItem[] = [];
  const seen = new Set<string>();
  scope.find('a[href*="/anime/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const slug = href.split('/').filter(Boolean).pop() || '';
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const img = $el.find('img').first();
    const poster = img.attr('data-src') || img.attr('src') || undefined;
    const title = $el.find('h3').first().text().trim();
    if (!title) return;
    const item: MediaItem = { id: `gani_${slug}`, title, poster, type: 'anime' };
    const yearText = $el.find('span[style*="ffc119"]').text();
    const yearMatch = yearText.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) item.year = parseInt(yearMatch[0], 10);
    const badge = $el.find('.badge').first().text().trim();
    const badgeNumber = badge.match(/(\d+)/);
    if (badgeNumber) item.episode = parseInt(badgeNumber[1], 10);
    items.push(item);
  });
  return items;
}

/** Últimas temporadas desde https://latanime.org/emision: los animes en emisión
 *  con su temporada actual (derivada del título/slug) y el año. */
export async function scrapeLatanimeEmision(): Promise<MediaItem[]> {
  try {
    const html = await fetchHTML(`${BASE_URL}/emision`);
    const $ = cheerio.load(html);
    const items = parseAnimeCards($, $.root());
    for (const item of items) {
      const title = item.title;
      item.season = seasonFromTitle(title, item.id.replace(/^gani_/, ''));
    }
    logger.info({ emision: items.length }, 'Latanime emisión scraped');
    return items;
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Latanime: fallo al scrapear la emisión');
    return [];
  }
}

/** Busca animes por query y retorna todos los resultados (hasta 20). */
export async function searchLatanimeResults(query: string): Promise<MediaItem[]> {
  try {
    const searchUrl = `${BASE_URL}/buscar?q=${encodeURIComponent(query)}`;
    const html = await fetchHTML(searchUrl);
    const $ = cheerio.load(html);
    const items: MediaItem[] = [];
    const seen = new Set<string>();
    // Primer pase: cards con link a /anime/
    $('a[href*="/anime/"]').each((_, el) => {
      if (items.length >= 20) return false;
      const href = absoluteUrl($(el).attr('href') || '', `${BASE_URL}/buscar`);
      if (!href) return;
      try {
        const { hostname, pathname } = new URL(href);
        if (hostname !== 'latanime.org') return;
        const slug = pathname.split('/').filter(Boolean).pop() || '';
        if (!slug || seen.has(slug)) return;
        seen.add(slug);
        const img = $(el).find('img').first();
        const poster = img.attr('data-src') || img.attr('src') || undefined;
        const title = $(el).find('h3').first().text().trim() || slug.replace(/-/g, ' ');
        if (!title) return;
        items.push({ id: `gani_${slug}`, title, poster, type: 'anime' });
      } catch { /* skip */ }
    });
    logger.info({ query, results: items.length }, 'Latanime search');
    return items;
  } catch (error) {
    logger.error({ query, error: (error as Error).message }, 'Latanime search failed');
    return [];
  }
}

/** Calendario de https://latanime.org/calendario para un día concreto
 *  (lunes/martes/miercoles/jueves/viernes/sabado/domingo/otros). */
export async function scrapeLatanimeCalendarDay(day: string): Promise<{ day: string; items: MediaItem[] }> {
  try {
    const html = await fetchHTML(`${BASE_URL}/calendario`);
    const $ = cheerio.load(html);
    const pane = $(`#${day}-tap-pane`).first();
    const items = parseAnimeCards($, pane.length ? pane : $.root());
    logger.info({ day, items: items.length }, 'Latanime calendario scraped');
    return { day: day.charAt(0).toUpperCase() + day.slice(1), items };
  } catch (error) {
    logger.error({ error: (error as Error).message, day }, 'Latanime: fallo al scrapear el calendario');
    return { day: day.charAt(0).toUpperCase() + day.slice(1), items: [] };
  }
}
