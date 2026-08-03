import { FastifyInstance } from 'fastify';
import { httpClient } from '../../utils/http';
import { logger } from '../../utils/logger';
import { verifyCookies } from '../../utils/cookie-token';
import { buildProxyUrl } from '../../utils/proxy-url';
import { refreshExpiredChannelUrl } from '../live-tv/controller';
import { isNetuHost, resolveNetuStream } from '../../services/netu-resolver';

// Importante: el CDN de tvporinternet2 (playlist.php) SOLO acepta este
// User-Agent exacto (Chrome/120). Cualquier otra versión → 403.
const STREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

function isDash(url: string, contentType: string): boolean {
  return url.toLowerCase().includes('.mpd') ||
    contentType.toLowerCase().includes('application/dash+xml');
}

/** True si la URL interna trae `expires=` en el pasado (token ya vencido). */
function innerUrlExpired(target: string): boolean {
  try {
    const exp = parseInt(new URL(target).searchParams.get('expires') || '', 10);
    if (!isFinite(exp)) return false;
    return exp * 1000 < Date.now();
  } catch {
    return false;
  }
}

/** Extrae url/referer/cookies de una URL del proxy (`/proxy/stream?url=…`). */
function parseProxiedUrl(proxied: string): { url?: string; referer?: string; cookies?: string } {
  try {
    const rp = new URL(proxied, 'http://localhost');
    return {
      url: rp.searchParams.get('url') || undefined,
      referer: rp.searchParams.get('referer') || undefined,
      cookies: rp.searchParams.get('cookies') || undefined,
    };
  } catch {
    return {};
  }
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

/**
 * Reescribe un manifiesto DASH (.mpd): envuelve en el proxy las URLs de
 * segmentos y BaseURL para que el reproductor nunca acceda directo al CDN.
 */
function rewriteDash(content: string, baseUrl: string, referer?: string, cookies?: string): string {
  const wrap = (u: string): string => buildProxyUrl(resolveUrl(baseUrl, u.trim()), referer, cookies);
  let out = content.replace(/(<BaseURL[^>]*>)([^<]*?)(<\/BaseURL>)/g, (_m, open: string, url: string, close: string) => {
    const t = url.trim();
    if (!t) return _m;
    return open + wrap(t) + close;
  });
  out = out.replace(/((?:sourceURL|media|initialization|xlink:href)\s*=\s*")([^"]+?)(")/g, (_m, pre: string, url: string, post: string) => {
    const t = url.trim();
    if (!t || t.startsWith('data:') || t.startsWith('urn:')) return _m;
    return pre + wrap(t) + post;
  });
  return out;
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

  // Varios CDNs de streams (bozztv, aiv-cdn, otte.live) tienen DNS inestable:
  // reintentar solo ante errores de red/DNS, sin retry sobre 4xx/5xx.
  const dnsErrors = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'];
  let lastErr: any;
  let res: import('axios').AxiosResponse;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await httpClient.get(target, {
        headers,
        responseType: 'stream',
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true,
      });
      break;
    } catch (err: any) {
      lastErr = err;
      const code = err?.code || err?.cause?.code;
      if (!dnsErrors.includes(code) || attempt >= 3) throw err;
      logger.warn({ url: target.substring(0, 160), code, attempt }, 'Proxy: DNS/red inestable, reintentando');
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

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
    // Streams directos .ts con token (p.ej. tvporinternet2) también caducan,
    // y sus playlists vivos (playlist.php) pueden vencer (403) → refrescar
    const requestedLooksStreaming = requestedIsPlaylist || url.toLowerCase().includes('.ts') || url.toLowerCase().includes('playlist.php') || url.toLowerCase().includes('.mpd');

    try {
      let upstream = await fetchUpstream(target, effectiveReferer, effectiveCookies);

      // Netu: la página embed carga el stream vía JS (no hay m3u8 en el HTML
      // estático) y sus URLs HLS llevan token por IP + expiración. Si el
      // upstream devolvió HTML, resolver el stream real con Playwright
      // (Cloud Run) y servirlo desde la misma IP que lo resolvió.
      if (isNetuHost(target) && upstream.contentType.toLowerCase().includes('text/html')) {
        const resolved = await resolveNetuStream(target);
        if (resolved.url) {
          upstream.res.data.resume();
          target = resolved.url;
          if (resolved.referer) effectiveReferer = resolved.referer;
          if (resolved.cookies) effectiveCookies = resolved.cookies;
          upstream = await fetchUpstream(target, effectiveReferer, effectiveCookies);
          logger.info({ url: target.substring(0, 160) }, 'Proxy: stream netu resuelto');
        }
      }

      // Si el stream expiró — token vencido (expires en el pasado) o el
      // upstream devolvió 4xx (m3u8 vencido o .ts con token muerto) —,
      // refrescar el canal y servir la URL nueva vigente.
      if (requestedLooksStreaming && (upstream.res.status >= 400 || innerUrlExpired(url))) {
        const refreshed = await refreshExpiredChannelUrl(url);
        if (refreshed) {
          const parsed = parseProxiedUrl(refreshed);
          if (parsed.url) {
            try {
              upstream.res.data.resume();
              upstream = await fetchUpstream(
                parsed.url,
                parsed.referer || effectiveReferer,
                parsed.cookies ? verifyCookies(parsed.cookies) : effectiveCookies,
              );
              target = parsed.url;
              effectiveReferer = parsed.referer || effectiveReferer;
              effectiveCookies = parsed.cookies ? verifyCookies(parsed.cookies) : effectiveCookies;
              logger.info({ url: target.substring(0, 200) }, 'Proxy: stream re-extracted after expiry');
            } catch {
              // Si falla la re-extracción, se responde el error original
            }
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

      if (isDash(upstream.finalUrl, upstream.contentType)) {
        const chunks: Buffer[] = [];
        for await (const chunk of upstream.res.data) {
          chunks.push(Buffer.from(chunk));
        }
        const content = Buffer.concat(chunks).toString('utf-8');
        const rewritten = rewriteDash(content, upstream.finalUrl, effectiveReferer, effectiveCookies);
        reply.header('Content-Type', 'application/dash+xml');
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
