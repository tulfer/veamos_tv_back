import { httpClient } from '../utils/http';
import { Episode, Season } from '../types';
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

async function fetchEpisodeServer(episodeUrl: string): Promise<string | null> {
  // Las páginas de episodio pueden responder 404 pese a incluir el reproductor (SSR).
  const res = await httpClient.get(episodeUrl, { timeout: 20000, validateStatus: () => true });
  const html = typeof res.data === 'string' ? res.data : '';
  const src =
    html.match(/<iframe\b[^>]*id=["']iframe-video["'][^>]*src=["']([^"']+)/i)?.[1] ||
    html.match(/<iframe\b[^>]*src=["']([^"']+)["'][^>]*id=["']iframe-video["']/i)?.[1];
  return src ? src.replace(/&(?:amp|#0?3?8);/gi, '&').trim() : null;
}

/** Obtiene los episodios en LATINO del anime en animejara, resolviendo su slug vía jkanime. */
export async function scrapeAnimejaraDetail(slug: string, onLog?: (message: string) => void): Promise<{ seasons: Season[] } | null> {
  try {
    const animejaraSlug = await searchJkanimeSlug(slug, onLog);
    if (!animejaraSlug) return null;
    const detailUrl = `${ANIMEJARA_BASE}/anime/${animejaraSlug}`;
    onLog?.(`AnimeJara: consultando ${detailUrl}`);
    const res = await httpClient.get(detailUrl, { timeout: 20000 });
    const html = typeof res.data === 'string' ? res.data : '';
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
        const serverUrl = await fetchEpisodeServer(episodeUrl);
        if (!serverUrl) {
          onLog?.(`AnimeJara: episodio ${number} sin iframe de reproductor`);
          continue;
        }
        onLog?.(`AnimeJara: episodio ${number} (Latino) -> ${serverUrl}`);
        episodes.push({
          id: `${slug}_e${number}`,
          title: ep.nombre_episodio || `Episodio ${number}`,
          duration: '24m',
          episode_number: number,
          videos: [{ language: 'Latino', servers: [{ name: 'AnimeJara', url: serverUrl }] }],
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