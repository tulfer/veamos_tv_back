import { FastifyInstance } from 'fastify';
import { httpClient } from '../../utils/http';
import { logger } from '../../utils/logger';
import { signCookies, verifyCookies } from '../../utils/cookie-token';
import { refreshExpiredChannelUrl } from '../live-tv/controller';

const STREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const PLAYLIST_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegURL',
  'application/mpegurl',
  'vnd.apple.mpegurl',
];

function isPlaylist(url: string, contentType: string): boolean {
  return url.toLowerCase().includes('.m3u8') ||
    url.toLowerCase().includes('.m3u') ||
    PLAYLIST_TYPES.some((t) => contentType.toLowerCase().includes(t));
}

function buildProxyUrl(target: string, referer?: string, cookies?: string): string {
  const params = new URLSearchParams();
  params.set('url', target);
  if (referer) params.set('referer', referer);
  const token = signCookies(cookies);
  if (token) params.set('cookies', token);
  return `/proxy/stream?${params.toString()}`;
}

function resolveUrl(base: string, target: string): string {
  try {
    return new URL(target, base).toString();
  } catch {
    return target;
  }
}

function rewritePlaylist(content: string, baseUrl: string, referer?: string, cookies?: string): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('#') && trimmed.length > 0) {
        return buildProxyUrl(resolveUrl(baseUrl, trimmed), referer, cookies);
      }
      if (trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
          `URI="${buildProxyUrl(resolveUrl(baseUrl, uri), referer, cookies)}"`);
      }
      return line;
    })
    .join('\n');
}

interface UpstreamResult {
  res: import('axios').AxiosResponse;
  finalUrl: string;
  contentType: string;
}

async function fetchUpstream(target: string, referer?: string, cookies?: string): Promise<UpstreamResult> {
  const headers: Record<string, string> = {
    'User-Agent': STREAM_UA,
    'Accept': '*/*',
  };
  if (referer) {
    headers['Referer'] = referer;
  }
  if (cookies) {
    headers['Cookie'] = cookies;
  }

  const res = await httpClient.get(target, {
    headers,
    responseType: 'stream',
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: () => true,
  });

  const finalUrl = String(res.request?.res?.responseUrl || res.request?.responseURL || target);
  const contentType = String(res.headers['content-type'] || '');
  return { res, finalUrl, contentType };
}

export async function proxyRoutes(app: FastifyInstance) {
  app.get('/proxy/stream', async (request, reply) => {
    const { url, referer, cookies } = request.query as Record<string, string>;

    if (!url || typeof url !== 'string') {
      return reply.status(400).send({ error: 'url param is required' });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return reply.status(400).send({ error: 'Invalid url' });
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return reply.status(400).send({ error: 'Only http(s) URLs are allowed' });
    }

    let target = url;
    let effectiveReferer = referer && typeof referer === 'string' ? referer : undefined;
    let effectiveCookies = verifyCookies(cookies);
    const requestedIsPlaylist = isPlaylist(url, '');

    try {
      let upstream = await fetchUpstream(target, effectiveReferer, effectiveCookies);

      // Si el playlist (m3u8) expiró (4xx), refrescar el canal y servir la URL nueva vigente
      if (upstream.res.status >= 400 && requestedIsPlaylist) {
        const refreshed = await refreshExpiredChannelUrl(url);
        if (refreshed) {
          try {
            const rp = new URL(refreshed, 'http://localhost');
            const newUrl = rp.searchParams.get('url');
            const newReferer = rp.searchParams.get('referer') || undefined;
            const newCookies = verifyCookies(rp.searchParams.get('cookies'));
            if (newUrl) {
              upstream.res.data.resume();
              upstream = await fetchUpstream(newUrl, newReferer, newCookies);
              target = newUrl;
              effectiveReferer = newReferer;
              effectiveCookies = newCookies;
              logger.info({ url: target.substring(0, 200) }, 'Proxy: stream re-extracted after expiry');
            }
          } catch {
            // Si falla la re-extracción, se responde el error original
          }
        }
      }

      if (upstream.res.status >= 400) {
        logger.warn({ url: target.substring(0, 200), status: upstream.res.status }, 'Proxy: upstream error');
        upstream.res.data.resume();
        return reply.status(upstream.res.status).send({ error: `Upstream error ${upstream.res.status}` });
      }

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Cache-Control', 'public, max-age=3600');

      if (isPlaylist(upstream.finalUrl, upstream.contentType)) {
        const chunks: Buffer[] = [];
        for await (const chunk of upstream.res.data) {
          chunks.push(Buffer.from(chunk));
        }
        const content = Buffer.concat(chunks).toString('utf-8');
        const rewritten = rewritePlaylist(content, upstream.finalUrl, effectiveReferer, effectiveCookies);
        reply.header('Content-Type', 'application/vnd.apple.mpegurl');
        // Los playlists HLS en vivo deben recargarse siempre: no cachear nunca
        // (un cache intermedio serviría un playlist viejo y cortaría el stream).
        reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        reply.header('Pragma', 'no-cache');
        return reply.send(rewritten);
      }

      const outType = upstream.contentType || 'application/octet-stream';
      reply.header('Content-Type', outType);
      if (upstream.res.headers['content-length']) {
        reply.header('Content-Length', String(upstream.res.headers['content-length']));
      }
      return reply.send(upstream.res.data);
    } catch (error: any) {
      logger.error({ error: error.message, url: target.substring(0, 200) }, 'Proxy: fetch failed');
      return reply.status(502).send({ error: 'Proxy fetch failed' });
    }
  });
}
