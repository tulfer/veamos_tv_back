import { httpClient } from '../utils/http';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';

const CACHE_TTL = 600_000;
// TTL menor para fallos de resolución: un embed roto no debe reintentarse en
// cada prefetch (cada intento espera el timeout), pero tampoco quedar inutilizable
// para siempre si el host vuelve.
const FAIL_CACHE_TTL = 120_000;

const STREAM_PATTERNS = [
  /(https?:\/\/[^"'\\\s<>]+\.(?:m3u8|mp4)[^"'\\\s<>]*)/gi,
  /(https?:\/\/[^"'\\\s<>]+\/playlist[^"'\\\s<>]*)/gi,
  /(https?:\/\/[^"'\\\s<>]+\/manifest[^"'\\\s<>]*)/gi,
  /file["'\s]*[:=]["'\s]*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
  /src=["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
];

async function fetchPage(url: string): Promise<string> {
  const response = await httpClient.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://www.pelisplushd.la/',
    },
  });
  return typeof response.data === 'string' ? response.data : '';
}

function findStreamUrl(html: string): string | null {
  // Las páginas embed (p.ej. netu) incluyen URLs de ejemplo dentro de
  // comentarios /* */ (plantillas del player) que NO son el stream real.
  // Quitarlas antes de buscar para no almacenar URLs vencidas de ejemplo.
  const clean = html
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const pattern of STREAM_PATTERNS) {
    const match = pattern.exec(clean);
    if (match) {
      const url = match[1] || match[0];
      if (url.startsWith('http') && (url.includes('.m3u8') || url.includes('.mp4'))) {
        return url;
      }
    }
  }
  return null;
}

export async function closeBrowser(): Promise<void> {
  // no-op: browserless mode
}

export async function resolveVideoUrl(embedUrl: string): Promise<string> {
  const cacheKey = `resolved:video:${embedUrl}`;
  const cached = memoryCache.get<string>(cacheKey);
  // El fallback devuelve la misma embedUrl; si está cacheado, reutilizarlo evita
  // reintentar hosts rotos en cada item del prefetch.
  if (cached) return cached;

  try {
    const html = await fetchPage(embedUrl);
    let streamUrl = findStreamUrl(html);

    if (!streamUrl) {
      const iframeMatch = html.match(/<iframe[^>]*src="([^"]+)"/i);
      if (iframeMatch) {
        const innerUrl = iframeMatch[1].startsWith('http')
          ? iframeMatch[1]
          : `https://${new URL(embedUrl).hostname}${iframeMatch[1]}`;

        if (!innerUrl.includes('google') && !innerUrl.includes('doubleclick')) {
          const innerHtml = await fetchPage(innerUrl);
          streamUrl = findStreamUrl(innerHtml);
        }
      }
    }

    const result = streamUrl || embedUrl;
    memoryCache.set(cacheKey, result, streamUrl ? CACHE_TTL : FAIL_CACHE_TTL);
    return result;
  } catch (error) {
    logger.warn({ error, embedUrl }, 'Failed to resolve video URL');
    // Cachear el fallo (corto) para no reintentar hosts muertos en cada prefetch.
    memoryCache.set(cacheKey, embedUrl, FAIL_CACHE_TTL);
    return embedUrl;
  }
}
