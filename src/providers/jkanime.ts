import * as cheerio from 'cheerio';
import { fetchHTML } from '../utils/http';
import { Episode, Season, VideoLanguage, VideoServer } from '../types';
import { isUnsupportedVideoHost } from '../utils/unsupported-video-hosts';

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

function extractServers($: cheerio.CheerioAPI, pageUrl: string): VideoLanguage[] {
  const servers: VideoServer[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined, name?: string) => {
    const url = raw ? absoluteUrl(raw.trim(), pageUrl) : null;
    if (!url || seen.has(url) || isUnsupportedVideoHost(url)) return;
    if (new URL(url).hostname === 'jkanime.net') return;
    seen.add(url);
    servers.push({ name: name?.trim() || `Servidor ${servers.length + 1}`, url });
  };
  $('[data-url],[data-src],[data-video], iframe[src], video source[src]').each((_, element) => {
    const $element = $(element);
    add($element.attr('data-url') || $element.attr('data-src') || $element.attr('data-video') || $element.attr('src'), $element.text());
  });
  $('a[href]').each((_, element) => add($(element).attr('href'), $(element).text()));
  return servers.length ? [{ language: 'Subtitulado', servers }] : [];
}

export async function scrapeJkanimeDetail(slug: string, onLog?: (message: string) => void): Promise<{ seasons: Season[] } | null> {
  try {
    const query = slug.replace(/-/g, ' ');
    const searchUrl = `${BASE_URL}/buscar/${encodeURIComponent(query)}`;
    onLog?.(`JKAnime: consultando búsqueda ${searchUrl}`);
    const searchHtml = await fetchHTML(searchUrl);
    const search = cheerio.load(searchHtml);
    let detailUrl: string | null = null;
    search('a[href]').each((_, element) => {
      if (detailUrl) return;
      const href = absoluteUrl(search(element).attr('href') || '', searchUrl);
      if (href && new URL(href).hostname === 'jkanime.net' && /\/(?:anime|ver)\//i.test(new URL(href).pathname)) detailUrl = href;
    });
    if (!detailUrl) {
      onLog?.('JKAnime: no se encontró resultado en la búsqueda');
      return null;
    }
    onLog?.(`JKAnime: resultado encontrado ${detailUrl}`);
    const html = await fetchHTML(detailUrl);
    const $ = cheerio.load(html);
    const links = new Map<number, string>();
    $('a[href]').each((_, element) => {
      const href = absoluteUrl($(element).attr('href') || '', detailUrl!);
      if (!href || new URL(href).hostname !== 'jkanime.net') return;
      const number = episodeNumber(`${$(element).text()} ${href}`);
      if (number && number > 0 && !links.has(number)) links.set(number, href);
    });
    onLog?.(`JKAnime: ${links.size} enlaces de episodios detectados`);
    const episodes: Episode[] = [];
    for (const [number, url] of [...links.entries()].sort(([a], [b]) => a - b)) {
      try {
        const episodeVideos = extractServers(cheerio.load(await fetchHTML(url)), url);
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
