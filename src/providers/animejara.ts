import { httpClient } from '../utils/http';
import * as cheerio from 'cheerio';
import { Episode, Season, VideoServer, MediaItem, BannerItem } from '../types';
import { isUnsupportedVideoHost } from '../utils/unsupported-video-hosts';
import { searchJkanimeSlug } from './jkanime';
import { getRow, setRow, storeKeys } from '../services/store';
import { logger } from '../utils/logger';

const ANIMEJARA_BASE = 'https://animejara.com';

interface AnimejaraSeasonData {
  numero_temporada: number;
  episodios: Array<{
    numero_episodio: string | number;
    nombre_episodio?: string;
    idiomas: string[] | string;
  }>;
}

async function fetchText(url: string, allow404 = false): Promise<string> {
  const opts = allow404 ? { timeout: 20000, validateStatus: () => true } : { timeout: 20000 };
  const res = await httpClient.get(url, opts);
  return typeof res.data === 'string' ? res.data : '';
}

async function fetchTextWithRetry(url: string, allow404 = false): Promise<string> {
  let lastError: { message: string };
  for (let i = 0; i < 3; i++) {
    try {
      return await fetchText(url, allow404);
    } catch (error) {
      lastError = error as { message: string };
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  throw lastError;
}

function extractTemporadasData(html: string): AnimejaraSeasonData[] | null {
  const marker = 'const TEMPORADAS_DATA = ';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  let start = idx + marker.length;
  while (start < html.length && /\s/.test(html[start])) start++;
  if (html[start] !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = start;
  for (; end < html.length; end++) {
    const ch = html[end];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  if (depth !== 0) return null;
  try {
    return JSON.parse(html.slice(start, end)) as AnimejaraSeasonData[];
  } catch {
    return null;
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|#0?38);/gi, '&').trim();
}

function extractIframeVideo(html: string): string | null {
  return (
    html.match(/<iframe\b[^>]*id=["']iframe-video["'][^>]*src=["']([^"']+)/i)?.[1] ||
    html.match(/<iframe\b[^>]*src=["']([^"']+)["'][^>]*id=["']iframe-video["']/i)?.[1]
  );
}

/** Obtiene la URL del reproductor del episodio (la página responde 404 pese a incluir el iframe SSR). */
async function fetchEpisodeEmbedUrl(episodeUrl: string): Promise<string | null> {
  try {
    const html = await fetchTextWithRetry(episodeUrl, true);
    const src = extractIframeVideo(html);
    return src ? decodeEntities(src) : null;
  } catch {
    return null;
  }
}

/**
 * Expande el embed de multiplayer.streamhj.top: la página es un selector de
 * servidores y cada <li> guarda uno de los espejos reales en su `onclick`.
 */
async function expandMultiplayerEmbed(src: string): Promise<VideoServer[]> {
  try {
    const html = await fetchTextWithRetry(src);
    const servers: VideoServer[] = [];
    const seen = new Set<string>();
    const liRe = /<li\b[^>]*\bonclick="([^"]*)"[^>]*>([\s\S]*?)<\/li>/gi;
    let match: ReturnType<RegExp['exec']> | null;
    while ((match = liRe.exec(html)) !== null) {
      const onclick = match[1] || '';
      const urlRaw = onclick.match(/playVideo\(&quot; ?([^"&]+)&quot;\)/i)?.[1];
      if (!urlRaw) continue;
      const url = decodeEntities(urlRaw);
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      const name =
        match[2].match(/<span[^>]*class=['"]nombre-server['"]>([^<]+)<\/span>/i)?.[1] ||
        match[2].match(/<img[^>]*alt=["']([^"']+)["']/i)?.[1] ||
        '';
      servers.push({ name: name.trim() || `Servidor ${servers.length + 1}`, url });
      seen.add(url);
    }
    return servers;
  } catch {
    return [];
  }
}

/** Obtiene los episodios en LATINO del anime en animejara, resolviendo su slug vía jkanime. */
export async function scrapeAnimejaraDetail(slug: string, onLog?: (message: string) => void): Promise<{ seasons: Season[] } | null> {
  try {
    const animejaraSlug = await searchJkanimeSlug(slug, onLog);
    if (!animejaraSlug) return null;
    const detailUrl = `${ANIMEJARA_BASE}/anime/${animejaraSlug}`;
    onLog?.(`AnimeJara: consultando ${detailUrl}`);
    const html = await fetchTextWithRetry(detailUrl);
    const temporadas = extractTemporadasData(html);
    if (!temporadas?.length) {
      onLog?.('AnimeJara: sin TEMPORADAS_DATA');
      return null;
    }
    const seasons: Season[] = [];
    for (const temporada of temporadas) {
      const seasonNumber = Number(temporada.numero_temporada) || 1;
      const episodes: Episode[] = [];
      for (const ep of temporada.episodios) {
        const number = Number(ep.numero_episodio);
        if (!Number.isFinite(number) || number <= 0) continue;
        const idiomas = Array.isArray(ep.idiomas) ? ep.idiomas.join(' ') : String(ep.idiomas || '');
        if (!/latino/i.test(idiomas)) continue;
        const episodeUrl = `${ANIMEJARA_BASE}/episode/${animejaraSlug}-${seasonNumber}x${number}/`;
        const embedUrl = await fetchEpisodeEmbedUrl(episodeUrl);
        if (!embedUrl) {
          onLog?.(`AnimeJara: episodio ${number} sin iframe de reproductor`);
          continue;
        }
        const mirrors = await expandMultiplayerEmbed(embedUrl);
        const usable = mirrors.filter((server) => !isUnsupportedVideoHost(server.url));
        const servers: VideoServer[] =
          mirrors.length > 0
            ? usable.length > 0
              ? usable
              : []
            : [{ name: 'AnimeJara', url: embedUrl }];
        if (servers.length === 0) {
          onLog?.(`AnimeJara: episodio ${number} solo tiene espejos no soportados`);
          continue;
        }
        onLog?.(`AnimeJara: episodio ${number} (Latino), ${servers.length} servidores`);
        episodes.push({
          id: `${slug}_e${number}`,
          title: ep.nombre_episodio || `Episodio ${number}`,
          duration: '24m',
          episode_number: number,
          videos: [{ language: 'Latino', servers }],
        });
      }
      if (episodes.length) seasons.push({ season_number: seasonNumber, title: `Temporada ${seasonNumber}`, episodes });
    }
    onLog?.(`AnimeJara: ${seasons.reduce((total, season) => total + season.episodes.length, 0)} episodios en latino`);
    return seasons.length ? { seasons } : null;
  } catch (error) {
    onLog?.(`AnimeJara: error ${(error as Error).message}`);
    return null;
  }
}

// ---- Home y catálogo (sección Anime del panel de sincronización) ----

export interface AnimeJaraHomeData {
  banners: BannerItem[];
  ultimosEpisodios: MediaItem[];
  topAnime: MediaItem[];
  todos: MediaItem[];
  totalTodos: number;
  updatedAt: number;
}

function animeSlugFromUrl(url: string): string | null {
  const match = url.replace(/\/+$/, '').match(/\/(?:anime|movie|episode)\/([a-z0-9-]+?)(?:-\d+x\d+)?(?:#|\/|$)/i);
  return match ? match[1] : null;
}

function extractJsArray(html: string, varName: string): string | null {
  const marker = `const ${varName} = `;
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  let start = idx + marker.length;
  while (start < html.length && /\s/.test(html[start])) start++;
  if (html[start] !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = start;
  for (; end < html.length; end++) {
    const ch = html[end];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  if (depth !== 0) return null;
  return html.slice(start, end);
}

/** Banner y últimos episodios desde https://animejara.com/inicio.
 *  El hero es un array JS `heroData` (tendencias al azar); la sección
 *  "Últimos Episodios" son tarjetas a.ep-card dentro de .anime-grid. */
export async function scrapeAnimejaraHome(): Promise<{ banners: BannerItem[]; ultimosEpisodios: MediaItem[] }> {
  try {
    const html = await fetchTextWithRetry(`${ANIMEJARA_BASE}/inicio`);
    const banners: BannerItem[] = [];

    const raw = extractJsArray(html, 'heroData');
    if (raw) {
      try {
        const heroData = JSON.parse(raw) as Array<{
          rank?: number;
          titulo?: string;
          sinopsis?: string;
          categorias?: string;
          imagen?: string;
          enlace?: string;
        }>;
        for (const entry of heroData) {
          const slug = entry.enlace ? animeSlugFromUrl(entry.enlace) : null;
          if (!slug || !entry.titulo) continue;
          const image = entry.imagen || '';
          banners.push({
            id: `gani_${slug}`,
            title: entry.titulo,
            description: entry.sinopsis,
            poster: image,
            backdrop: image,
            image,
            genres: (entry.categorias || '').split(',').map((g) => g.trim()).filter(Boolean),
            type: 'anime',
          });
        }
      } catch (error) {
        logger.warn({ error: (error as Error).message }, 'AnimeJara: no se pudo parsear heroData');
      }
    }

    const ultimosEpisodios: MediaItem[] = [];
    const seen = new Set<string>();
    const $ = cheerio.load(html);
    $('.anime-grid > a.ep-card').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const slug = animeSlugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const img = $el.find('img').first();
      const poster = img.attr('data-src') || img.attr('src') || undefined;
      const title = $el.find('.ep-name').first().text().trim();
      if (!title) return;
      ultimosEpisodios.push({ id: `gani_${slug}`, title, poster, type: 'anime' });
    });

    logger.info({ banners: banners.length, ultimosEpisodios: ultimosEpisodios.length }, 'AnimeJara home scraped');
    return { banners, ultimosEpisodios };
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'AnimeJara: fallo al scrapear el home');
    return { banners: [], ultimosEpisodios: [] };
  }
}

/** Lista el catálogo completo de animejara: https://animejara.com/catalogo/?paged={page}.
 *  La página devuelve HTTP 404 pero el cuerpo trae los ítems, por eso se acepta
 *  cualquier status. Cada tarjeta expone su metadata en data-anime (JSON). */
export async function scrapeAnimejaraCatalogPage(page: number): Promise<{ items: MediaItem[]; total: number }> {
  try {
    const html = await fetchTextWithRetry(`${ANIMEJARA_BASE}/catalogo/?paged=${page}`, true);
    const $ = cheerio.load(html);
    const items: MediaItem[] = [];
    $('#anime-results a.anime-card[data-anime]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const slug = animeSlugFromUrl(href);
      if (!slug) return;
      let data: { titulo?: string; poster?: string; anio?: string; rating?: number; sinopsis?: string; categorias?: string[] } | null = null;
      try {
        data = JSON.parse($el.attr('data-anime') || '') as typeof data;
      } catch {
        data = null;
      }
      const title = data?.titulo || $el.find('img').first().attr('alt') || '';
      if (!title) return;
      items.push({
        id: `gani_${slug}`,
        title,
        poster: data?.poster || $el.find('img').first().attr('src') || undefined,
        description: data?.sinopsis,
        year: data?.anio ? parseInt(data.anio, 10) || undefined : undefined,
        rating: data?.rating ? data.rating : undefined,
        genres: Array.isArray(data?.categorias) ? data!.categorias : undefined,
        type: 'anime',
      });
    });
    const totalMatch = html.match(/id="total-animes"[^>]*>\s*(\d+)/i);
    return { items, total: totalMatch ? parseInt(totalMatch[1], 10) : 0 };
  } catch (error) {
    logger.error({ error: (error as Error).message, page }, 'AnimeJara: fallo al scrapear el catálogo');
    return { items: [], total: 0 };
  }
}

export async function saveAnimeJaraHomeData(data: AnimeJaraHomeData): Promise<void> {
  await setRow(storeKeys.animeHome, { ...data, updatedAt: Date.now() });
}

export async function loadAnimeJaraHomeData(): Promise<AnimeJaraHomeData | null> {
  return getRow<AnimeJaraHomeData>(storeKeys.animeHome);
}
