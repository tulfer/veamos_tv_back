import { httpClient } from '../utils/http';
import { Episode, Season, VideoServer } from '../types';
import { isUnsupportedVideoHost } from '../utils/unsupported-video-hosts';
import { searchJkanimeSlug } from './jkanime';

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