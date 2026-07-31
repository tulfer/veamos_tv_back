import { FastifyInstance } from 'fastify';
import { httpClient } from '../../utils/http';
import { logger } from '../../utils/logger';

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

function buildProxyUrl(target: string, referer?: string): string {
  const params = new URLSearchParams();
  params.set('url', target);
  if (referer) params.set('referer', referer);
  return `/proxy/stream?${params.toString()}`;
}

function resolveUrl(base: string, target: string): string {
  try {
    return new URL(target, base).toString();
  } catch {
    return target;
  }
}

function rewritePlaylist(content: string, baseUrl: string, referer?: string): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('#') && trimmed.length > 0) {
        return buildProxyUrl(resolveUrl(baseUrl, trimmed), referer);
      }
      if (trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
          `URI="${buildProxyUrl(resolveUrl(baseUrl, uri), referer)}"`);
      }
      return line;
    })
    .join('\n');
}

export async function proxyRoutes(app: FastifyInstance) {
  app.get('/proxy/stream', async (request, reply) => {
    const { url, referer } = request.query as Record<string, string>;

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

    const headers: Record<string, string> = {
      'User-Agent': STREAM_UA,
      'Accept': '*/*',
    };
    if (referer && typeof referer === 'string') {
      headers['Referer'] = referer;
    }

    try {
      const upstream = await httpClient.get(url, {
        headers,
        responseType: 'stream',
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true,
      });

      if (upstream.status >= 400) {
        logger.warn({ url: url.substring(0, 200), status: upstream.status }, 'Proxy: upstream error');
        upstream.data.resume();
        return reply.status(upstream.status).send({ error: `Upstream error ${upstream.status}` });
      }

      const finalUrl = String(upstream.request?.res?.responseUrl || upstream.request?.responseURL || url);
      const contentType = String(upstream.headers['content-type'] || '');

      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Cache-Control', 'public, max-age=3600');

      if (isPlaylist(finalUrl, contentType)) {
        const chunks: Buffer[] = [];
        for await (const chunk of upstream.data) {
          chunks.push(Buffer.from(chunk));
        }
        const content = Buffer.concat(chunks).toString('utf-8');
        const rewritten = rewritePlaylist(content, finalUrl, referer);
        reply.header('Content-Type', 'application/vnd.apple.mpegurl');
        return reply.send(rewritten);
      }

      const outType = contentType || 'application/octet-stream';
      reply.header('Content-Type', outType);
      if (upstream.headers['content-length']) {
        reply.header('Content-Length', String(upstream.headers['content-length']));
      }
      return reply.send(upstream.data);
    } catch (error: any) {
      logger.error({ error: error.message, url: url.substring(0, 200) }, 'Proxy: fetch failed');
      return reply.status(502).send({ error: 'Proxy fetch failed' });
    }
  });
}
