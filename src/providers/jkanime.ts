import * as cheerio from 'cheerio';
import { fetchHTML, httpClient } from '../utils/http';
import { Episode, Season, VideoLanguage, VideoServer, MediaItem } from '../types';
import { isUnsupportedVideoHost } from '../utils/unsupported-video-hosts';
import { logger } from '../utils/logger';

const BASE_URL = 'https://jkanime.net';

function absoluteUrl(value: string, base: string): string | null {
  try { const url = new URL(value, base); return /^https?:$/.test(url.protocol) ? url.toString() : null; } catch { return null; }
}

function episodeNumber(value: string): number | null {
  const named = value.match(/(?:episode|episodio|cap[ií]tulo)[^\d]{0,8}(\d+)/i);
  if (named) return Number(named[1]);
  const trailing = value.match(/(?:-|\/)(\d+)(?:\D*)$/);
  return trailing ? Number(trailing[1]) : null;
}

/** Obtiene la página con las cookies de sesión (Laravel) y el token CSRF. */
async function fetchPageWithSession(url: string): Promise<{ html: string; cookies: string; csrfToken: string | null } | null> {
  try {
    const res = await httpClient.get(url, { timeout: 20000 });
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie.map((c: string) => c.split(';')[0]).join('; ') : '';
    const html = typeof res.data === 'string' ? res.data : '';
    const csrfToken = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)/i)?.[1] || null;
    return { html, cookies, csrfToken };
  } catch {
    return null;
  }
}

/** Lista los números de episodio vía el AJAX de jkanime (Laravel, requiere CSRF). */
async function fetchJkanimeEpisodeNumbers(detailHtml: string, detailUrl: string, cookies: string, csrfToken: string): Promise<number[]> {
  const idMatch = detailHtml.match(/ajax\/(?:episodes|search_episode)\/(\d+)/i);
  if (!idMatch) return [];
  const animeId = idMatch[1];
  const numbers = new Set<number>();
  try {
    for (let page = 1; page <= 12; page++) {
      const res = await httpClient.post(
        `${BASE_URL}/ajax/episodes/${animeId}/${page}`,
        '',
        {
          timeout: 20000,
          headers: {
            Referer: detailUrl,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Cookie: cookies,
            'X-CSRF-TOKEN': csrfToken,
          },
        },
      );
      const json = res.data as { data?: Array<{ number?: number }>; last_page?: number } | null;
      const items = json?.data;
      if (!Array.isArray(items) || items.length === 0) break;
      for (const item of items) {
        const n = Number(item?.number);
        if (n > 0) numbers.add(n);
      }
      const lastPage = json?.last_page || 0;
      if (lastPage && page >= lastPage) break;
    }
  } catch {
    /* AJAX no disponible; se usará el scrape estático */
  }
  return [...numbers];
}

function extractServers($: cheerio.CheerioAPI, pageUrl: string, rawHtml?: string): VideoLanguage[] {
  const servers: VideoServer[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined, name?: string, allowAnyHost = false) => {
    const url = raw ? absoluteUrl(raw.trim().replace(/&amp;/g, '&'), pageUrl) : null;
    if (!url || seen.has(url) || isUnsupportedVideoHost(url)) return;
    try {
      const host = new URL(url).hostname;
      if (!allowAnyHost && host !== 'jkanime.net' && !/\/jkplayer\//i.test(url)) return;
      if (host === 'jkanime.net' && !/\/jkplayer\//i.test(url)) return;
    } catch { return; }
    if (/google|doubleclick|propeller|adsby|popads|adsterra/i.test(url)) return;
    if (/jkplayer\/c1\?u=$/.test(url)) return;
    seen.add(url);
    servers.push({ name: name?.trim() || `Servidor ${servers.length + 1}`, url });
  };
  $('iframe[src]').each((_, element) => {
    const $element = $(element);
    add($element.attr('src'), $element.attr('title') || $element.text() || 'Servidor');
  });
  $('[data-url],[data-src],[data-video]').each((_, element) => {
    const $element = $(element);
    add($element.attr('data-url') || $element.attr('data-src') || $element.attr('data-video'), $element.text());
  });
  // Los reproductores pueden vivir dentro de un <script> como 'video[0]="<iframe src=...>"'.
  if (rawHtml) {
    const iframeRe = /<iframe[^>]*?src=["'](https?:\/\/[^"'<>]+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = iframeRe.exec(rawHtml)) !== null) {
      add(m[1], 'Servidor');
    }
    // jkanime también declara todos sus espejos en el array JS `var servers = [...]`
    // con el `remote` en base64. Es la lista real de reproductores (Desu, Mega,
    // Streamwish, Vidhide, Doodstream, etc.) que la UI carga dinámicamente.
    const serversRe = /var\s+servers\s*=\s*(\[[^\]]*\])\s*;?/;
    const serversJson = serversRe.exec(rawHtml)?.[1];
    if (serversJson) {
      try {
        const list = JSON.parse(serversJson) as Array<{ remote?: string; server?: string }>;
        for (const item of list) {
          if (!item.remote || !item.server) continue;
          try {
            const decoded = Buffer.from(item.remote, 'base64').toString('utf-8');
            if (!/^https?:\/\//i.test(decoded)) continue;
            if (/mediafire\.com|mediafire\.io/i.test(decoded)) continue;
            add(decoded, item.server, true);
          } catch { /* URL no válida */ }
        }
      } catch { /* array no parseado */ }
    }
  }
  return servers.length ? [{ language: 'Subtitulado', servers }] : [];
}

function pickJkanimeDetail(search: cheerio.CheerioAPI, searchUrl: string): string | null {
  let detailUrl: string | null = null;
  // Resultados de animes suelen estar en contenedores .anime__item
  search('.anime__item a[href]').each((_, element) => {
    if (detailUrl) return;
    const href = absoluteUrl(search(element).attr('href') || '', searchUrl);
    if (href && new URL(href).hostname === 'jkanime.net' && /^https?:\/\/jkanime\.net\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(href)) detailUrl = href;
  });
  if (!detailUrl) {
    const NAV_PATHS = /\/\b(?:buscar|usuario|dash|notificaciones|guardado|historial|directorio|horario|comunidad|aplicacion|estrenos|top|salida|lista)\b/i;
    search('a[href]').each((_, element) => {
      if (detailUrl) return;
      const href = absoluteUrl(search(element).attr('href') || '', searchUrl);
      if (!href) return;
      try {
        const { hostname, pathname } = new URL(href);
        if (hostname !== 'jkanime.net' || NAV_PATHS.test(pathname)) return;
        if (/\.(?:css|js|png|jpg|jpeg|gif|webp|svg)$/i.test(pathname)) return;
        if (/^\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/i.test(pathname)) detailUrl = href;
      } catch { /* ignorar */ }
    });
  }
  return detailUrl;
}

/** Resuelve el slug de anime en jkanime a partir del slug en inglés del catálogo. */
export async function searchJkanimeSlug(slug: string, onLog?: (message: string) => void): Promise<string | null> {
  try {
    const query = slug.replace(/-/g, ' ');
    const searchUrl = `${BASE_URL}/buscar/${encodeURIComponent(query)}`;
    onLog?.(`JKAnime: consultando búsqueda ${searchUrl}`);
    const searchHtml = await fetchHTML(searchUrl);
    const detailUrl = pickJkanimeDetail(cheerio.load(searchHtml), searchUrl);
    if (!detailUrl) {
      onLog?.('JKAnime: no se encontró resultado en la búsqueda');
      return null;
    }
    onLog?.(`JKAnime: resultado encontrado ${detailUrl}`);
    return new URL(detailUrl).pathname.replace(/^\/+|\/+$/g, '');
  } catch (error) {
    onLog?.(`JKAnime: error ${(error as Error).message}`);
    return null;
  }
}

export async function scrapeJkanimeDetail(slug: string, onLog?: (message: string) => void): Promise<{ seasons: Season[] } | null> {
  try {
    const slugPath = await searchJkanimeSlug(slug, onLog);
    if (!slugPath) return null;
    const detailUrl = `${BASE_URL}/${slugPath}`;
    const session = await fetchPageWithSession(detailUrl);
    if (!session) return null;
    const $ = cheerio.load(session.html);
    const directEpisode = episodeNumber(detailUrl);
    if (directEpisode) {
      const videos = extractServers($, detailUrl, session.html);
      onLog?.(`JKAnime: episodio ${directEpisode}, ${videos.reduce((total, language) => total + language.servers.length, 0)} servidores`);
      return videos.length ? { seasons: [{ season_number: 1, title: 'Temporada 1', episodes: [{ id: `${slug}_e${directEpisode}`, title: `Episodio ${directEpisode}`, duration: '45m', episode_number: directEpisode, videos }] }] } : null;
    }
    const numbers = new Set<number>();
    // Episodios vía AJAX (requiere la sesión + CSRF recién obtenidos)
    if (session.cookies && session.csrfToken) {
      const ajaxNumbers = await fetchJkanimeEpisodeNumbers(session.html, detailUrl, session.cookies, session.csrfToken);
      for (const n of ajaxNumbers) numbers.add(n);
    }
    // Respaldo estático: solo enlaces del tipo /slug/<número>/
    $('a[href]').each((_, element) => {
      const href = absoluteUrl($(element).attr('href') || '', detailUrl!);
      if (!href || new URL(href).hostname !== 'jkanime.net') return;
      const urlNum = href.match(/\/\d+\/?$/)?.[0];
      if (!urlNum) return;
      const number = episodeNumber(href);
      if (number && number > 0) numbers.add(number);
    });
    onLog?.(`JKAnime: ${numbers.size} episodios detectados`);
    const episodes: Episode[] = [];
    for (const number of [...numbers].sort((a, b) => a - b)) {
      try {
        const url = `${detailUrl.replace(/\/$/, '')}/${number}/`;
        const episodeHtml = await fetchHTML(url);
        const episodeVideos = extractServers(cheerio.load(episodeHtml), url, episodeHtml);
        onLog?.(`JKAnime: episodio ${number}, ${episodeVideos.reduce((total, language) => total + language.servers.length, 0)} servidores`);
        if (episodeVideos.length) episodes.push({ id: `${slug}_e${number}`, title: `Episodio ${number}`, duration: '45m', episode_number: number, videos: episodeVideos });
      } catch { /* episodio no disponible */ }
    }
    onLog?.(`JKAnime: ${episodes.length} episodios con videos`);
    return episodes.length ? { seasons: [{ season_number: 1, title: 'Temporada 1', episodes }] } : null;
  } catch (error) {
    onLog?.(`JKAnime: error ${(error as Error).message}`);
    return null;
  }
}

/** Top Anime desde el home de jkanime: los 10 ítems de las dos filas al final
 *  (.row.upto con 4 + .row.lower con 6), cada uno con su posición (data-rank),
 *  que NO es una calificación sino el orden del ranking. */
export async function scrapeJkanimeTopAnime(): Promise<MediaItem[]> {
  try {
    const html = await fetchHTML(`${BASE_URL}/`);
    const $ = cheerio.load(html);
    const items: MediaItem[] = [];
    const seen = new Set<string>();
    $('.row.upto .col.toplist .card a[href], .row.lower .col.toplist .card a[href]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const slug = href.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const title = $el.find('.card-title').first().text().trim();
      if (!title) return;
      const poster = $el.find('.card-img img').first().attr('src') || undefined;
      const rankText = $el.find('[data-rank]').first().attr('data-rank') || '';
      items.push({
        id: `gani_${slug}`,
        title,
        poster,
        order: rankText ? parseInt(rankText, 10) : undefined,
        type: 'anime',
      });
    });
    logger.info({ topAnime: items.length }, 'JKAnime top anime scraped');
    return items;
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'JKAnime: fallo al scrapear el top anime');
    return [];
  }
}

/** Últimos episodios desde la sección "Programación" del home de jkanime:
 *  los 32 ítems de la pestaña "Animes" (el último episodio emitido de cada
 *  anime, con su poster de la serie). */
export async function scrapeJkanimeSchedule(): Promise<MediaItem[]> {
  try {
    const html = await fetchHTML(`${BASE_URL}/`);
    const $ = cheerio.load(html);
    const items: MediaItem[] = [];
    $('#animes .dir1 > .card > a').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const parts = href.replace(/\/+$/, '').split('/').filter(Boolean);
      const slug = parts.length >= 2 ? parts[parts.length - 2] : '';
      if (!slug) return;
      const title = $el.find('.card-title').first().text().trim();
      if (!title) return;
      const img = $el.find('img').first();
      const poster = img.attr('data-animepic') || img.attr('src') || undefined;
      items.push({ id: `gani_${slug}`, title, poster, type: 'anime' });
    });
    logger.info({ schedule: items.length }, 'JKAnime programación scraped');
    return items;
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'JKAnime: fallo al scrapear la programación');
    return [];
  }
}
