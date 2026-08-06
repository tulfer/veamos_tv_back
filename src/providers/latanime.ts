import * as cheerio from 'cheerio';
import { fetchHTML } from '../utils/http';
import { Episode, Season, VideoLanguage, VideoServer } from '../types';
import { isUnsupportedVideoHost } from '../utils/unsupported-video-hosts';

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

  $('[data-url],[data-src],[data-video], iframe[src], video source[src]').each((_, element) => {
    const $element = $(element);
    add($element.attr('data-url') || $element.attr('data-src') || $element.attr('data-video') || $element.attr('src'), $element.text());
  });
  $('[data-url],[data-src],[data-video], .server-list a[href], .servers a[href], .video-servers a[href], [class*="server"] a[href], [id*="server"] a[href]').each((_, element) => {
    const $element = $(element);
    const href = $element.attr('href') || '';
    if (/\.(?:jpg|jpeg|png|gif|css|js)(?:\?|$)/i.test(href)) return;
    if (streamingNames.test($element.text()) || $element.attr('data-url') || $element.attr('data-src') || $element.attr('data-video')) {
      add(href || $element.attr('data-url') || $element.attr('data-src') || $element.attr('data-video'), $element.text());
    }
  });
  return servers.length ? [{ language: 'Latino', servers }] : [];
}

export async function scrapeLatanimeDetail(slug: string, onLog?: (message: string) => void): Promise<{ seasons: Season[] } | null> {
  try {
    const query = slug.replace(/-/g, '+');
    const searchUrl = `${BASE_URL}/buscar?q=${query}`;
    onLog?.(`Latanime: consultando búsqueda ${searchUrl}`);
    const searchHtml = await fetchHTML(searchUrl);
    const search = cheerio.load(searchHtml);
    let detailUrl: string | null = null;
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
    const html = await fetchHTML(detailUrl);
    const $ = cheerio.load(html);
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
    return episodes.length ? { seasons: [{ season_number: 1, title: 'Temporada 1', episodes }] } : null;
  } catch (error) {
    onLog?.(`Latanime: error ${(error as Error).message}`);
    return null;
  }
}
