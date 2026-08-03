import * as cheerio from 'cheerio';
import { fetchHTML, fetchHTMLWithReferer, httpClient } from '../utils/http';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { env } from '../config/env';
import { pushLog } from '../services/sync-status';
import { LiveChannel } from '../types';
import { launchChromium } from './launch';
import { signCookies } from '../utils/cookie-token';

function elog(logType: string | undefined, msg: string): void {
  if (logType) pushLog(logType, msg);
}

function isM3u8Url(u: string): boolean {
  return /\.(?:m3u8|m3u)(?:[?#]|$)/i.test(u);
}

/**
 * Detecta URLs de "stream" que en realidad son scripts/librerías del player
 * (hls.js cargado desde un CDN), que se capturan por error y NO deben usarse
 * ni guardarse como URL de canal. También detecta URLs ya envueltas en el
 * proxy de streaming cuyo destino interno es una de esas librerías.
 */
export function isJunkStreamUrl(u?: string): boolean {
  if (!u) return false;
  const lower = u.toLowerCase();
  let target = lower;
  if (lower.includes('/proxy/stream?')) {
    try {
      const m = lower.match(/[?&]url=([^&]+)/);
      if (m) target = decodeURIComponent(m[1]).toLowerCase();
    } catch {
      // ignore
    }
  }
  return (
    /jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare|c\.jsdelivr/i.test(target) ||
    /\/npm\//.test(target) ||
    /\.js(?:[@?&#]|$)/.test(target) ||
    /hls\.test|hls\.js/.test(target) && /\.js/.test(target)
  );
}

/**
 * Captura las cookies del contexto de Playwright que el host de la URL
 * recibiría, para que el proxy de streaming pueda reenviarlas al reproducir
 * el m3u8 (algunos players las exigen). Devuelve el header Cookie o undefined.
 */
async function captureCookiesFromContext(context: any, url: string): Promise<string | undefined> {
  try {
    const cookies = await context.cookies(url);
    if (!cookies || cookies.length === 0) return undefined;
    return cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return undefined;
  }
}

const CHATYTVGRATIS_BASE = 'https://www.chatytvgratis.net';
const WSDEPORTES_BASE = 'https://wsdeportes.net';
const TVPORINTERNET2_BASE = 'https://www.tvporinternet2.com';
const SENALCOLOMBIA_BASE = 'https://www.senalcolombia.tv';
const SENALCOLOMBIA_STREAM_FALLBACK = 'https://streaming.rtvc.gov.co/TV_Senal_Colombia_live/smil:live.smil/playlist.m3u8';

// Palabras clave para identificar iframes de no-video (comentarios, redes, anuncios)
const IFRAME_BLACKLIST = [
  'jetpack', 'wordpress', 'comment', 'disqus', 'facebook', 'twitter',
  'instagram', 'googleads', 'doubleclick', 'ads', 'adserver', 'analytics',
  'likes-master', 'about:blank', 'pixel', 'quantserve',
];

function isBlacklistedIframe(src: string): boolean {
  if (!src || src === 'about:blank') return true;
  const lower = src.toLowerCase();
  return IFRAME_BLACKLIST.some((word) => lower.includes(word));
}

export async function getChatytv(channel: string, logType?: string): Promise<LiveChannel | null> {
  const cacheKey = `chatytv:${channel}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  const url = `${CHATYTVGRATIS_BASE}/${channel}/`;
  logger.info({ channel, url }, 'Fetching channel from chatytvgratis');
  elog(logType, `=== chatytv: ${channel} ===`);
  elog(logType, `Consultando: ${url}`);

  // 1) Extracción por cadena HTTP (embed.php → menu → opciones) sin navegador
  let extracted: { stream: string; title: string } | null = null;
  try {
    extracted = await extractChatyTvCloud(url);
    if (extracted) {
      logger.info({ url: extracted.stream.substring(0, 130) }, 'chatytvgratis: stream obtenido por cadena HTTP');
    }
  } catch (e: any) {
    logger.warn({ error: e.message, channel }, 'chatytvgratis: cadena HTTP fallida');
  }

  // 2) Fallback con Playwright
  if (!extracted) {
    logger.warn({ channel }, 'chatytvgratis: probando Playwright');
    extracted = await extractChatyTvPlaywright(channel, url);
  }

  if (!extracted || !extracted.stream) {
    logger.warn({ channel, url }, 'No valid stream source found on chatytvgratis');
    elog(logType, '❌ No se encontró stream en chatytv');
    return null;
  }

  elog(logType, `✅ URL final: ${extracted.stream}`);

  const result: LiveChannel = {
    id: `live_${channel}`,
    title: extracted.title || channel.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
    logo: undefined,
    group: 'Canales TV',
    url: extracted.stream,
    type: 'live',
    online: true,
    refreshUrl: url,
    proveedor: 'chatytv',
  };

  memoryCache.set(cacheKey, result, 3600000);
  return result;
}

async function extractChatyTvPlaywright(channel: string, url: string): Promise<{ stream: string; title: string } | null> {
  let browser: any = null;
  try {
    // Usar Playwright para renderizar JavaScript
    await import('playwright');
browser = await launchChromium();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Interceptar todas las peticiones de red para buscar URLs de streaming
    const capturedUrls: string[] = [];
    page.on('request', (request: any) => {
      const reqUrl = request.url();
      if (reqUrl.includes('.m3u8') || reqUrl.includes('.m3u') || reqUrl.includes('.ts') || 
          reqUrl.includes('mywebtv') || reqUrl.includes('tdtcloud') || reqUrl.includes('hls')) {
        capturedUrls.push(reqUrl);
        logger.info({ url: reqUrl.substring(0, 250) }, 'Captured streaming request');
      }
    });

    // También capturar respuestas
    page.on('response', (response: any) => {
      const respUrl = response.url();
      if (respUrl.includes('.m3u8') || respUrl.includes('.m3u') || respUrl.includes('mywebtv') || 
          respUrl.includes('tdtcloud') || respUrl.includes('hls')) {
        if (!capturedUrls.includes(respUrl)) {
          capturedUrls.push(respUrl);
          logger.info({ url: respUrl.substring(0, 250) }, 'Captured streaming response');
        }
      }
    });

    // Navegar a la página con timeout más largo
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Esperar a que cargue el contenido
    await page.waitForTimeout(5000);

    // Buscar cualquier tipo de contenedor de video/reproductor y hacer clic
    const clickTargets = [
      'button',
      'a[href]',
      '.player',
      '#player',
      '.video-container',
      '.embed-container',
      '.entry-content a',
      '.post-content a',
      'article a',
      'main a',
      '[onclick]',
      '[class*="play"]',
      '[class*="repro"]',
      '[class*="ver"]',
    ];

    // Intentar hacer clic en elementos que parezcan iniciar el video
    for (const selector of clickTargets) {
      try {
        const elements = await page.$$(selector);
        for (const el of elements) {
          const text = await el.textContent().catch(() => '');
          
          // Buscar elementos que contengan texto relacionado con ver/reproducir
          if (text && (text.toLowerCase().includes('ver') || text.toLowerCase().includes('repro') || 
              text.toLowerCase().includes('play') || text.toLowerCase().includes('online') ||
              text.toLowerCase().includes('canal'))) {
            logger.info({ selector, text: text.substring(0, 100) }, 'Clicking element with play-related text');
            await el.click().catch(() => {});
            await page.waitForTimeout(2000);
            break;
          }
        }
      } catch (e) {
        // ignore
      }
    }

    // Esperar un poco más para que se carguen los iframes dinámicos
    await page.waitForTimeout(3000);

    // Obtener el HTML renderizado final
    const html = await page.content();
    const $ = cheerio.load(html);

    await page.close();

    // Log all iframes for debug
    const allIframes = $('iframe');
    logger.info({ channel, iframeCount: allIframes.length }, 'All iframes found on page after interaction');
    allIframes.each((i, el) => {
      const src = $(el).attr('src') || 'no-src';
      const id = $(el).attr('id') || 'no-id';
      const cls = $(el).attr('class') || 'no-class';
      logger.info({ index: i, src: src.substring(0, 250), id, class: cls }, `Iframe ${i}`);
    });

    // --- Estrategia 1: Usar URLs capturadas via red ---
    let streamUrl: string | undefined;

    if (capturedUrls.length > 0) {
      // Tomar la primera URL .m3u8 o la que tenga mywebtv/tdtcloud
      const capturedMedia = capturedUrls.filter((u) => !isJunkStreamUrl(u));
      const m3u8Url = capturedMedia.find((u) => u.includes('.m3u8') || u.includes('.m3u'));
      const streamingUrl = capturedMedia.find((u) => u.includes('mywebtv') || u.includes('tdtcloud') || u.includes('hls'));
      streamUrl = m3u8Url || streamingUrl || capturedMedia[0];
      logger.info({ url: streamUrl.substring(0, 250), total: capturedMedia.length }, 'Using captured network URL');
    }

    // --- Estrategia 2: Buscar iframe de video real ---
    if (!streamUrl) {
      for (let i = 0; i < allIframes.length; i++) {
        const el = allIframes[i];
        const src = $(el).attr('src');
        if (isBlacklistedIframe(src || '')) continue;

        const allow = $(el).attr('allow') || '';
        const allowfullscreen = $(el).attr('allowfullscreen') !== undefined;
        const hasVideoFeatures = allowfullscreen ||
          allow.includes('autoplay') ||
          allow.includes('encrypted-media') ||
          allow.includes('picture-in-picture');

        if (src && src.startsWith('http') && src.length > 10 && hasVideoFeatures) {
          streamUrl = src;
          logger.info({ src: src.substring(0, 250), allow }, 'Found video iframe with video features');
          break;
        }
      }
    }

    // --- Estrategia 3: Cualquier iframe no-blacklisted ---
    if (!streamUrl) {
      for (let i = 0; i < allIframes.length; i++) {
        const src = $(allIframes[i]).attr('src');
        if (!isBlacklistedIframe(src || '') && src && src.startsWith('http') && src.length > 10) {
          streamUrl = src;
          logger.info({ src: src.substring(0, 250) }, 'Found non-blacklisted iframe');
          break;
        }
      }
    }

    // --- Estrategia 4: Buscar en data attributes ---
    if (!streamUrl) {
      const dataCandidates = $('[data-src], [data-url], [data-stream], [data-video], [data-lazy-src]');
      dataCandidates.each((i, el) => {
        const val = $(el).attr('data-src') || $(el).attr('data-url') || $(el).attr('data-stream') || $(el).attr('data-video') || $(el).attr('data-lazy-src');
        if (val && (val.startsWith('http') || val.includes('.m3u8')) && val.length > 10) {
          streamUrl = val;
          logger.info({ dataSrc: val.substring(0, 250) }, 'Found video source in data attribute');
          return false;
        }
      });
    }

    // --- Estrategia 5: Buscar URLs m3u8 en el HTML completo ---
    if (!streamUrl) {
      const bodyHtml = $.html();
      const m3u8Matches = bodyHtml.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/gi);
      if (m3u8Matches && m3u8Matches.length > 0) {
        streamUrl = m3u8Matches[0];
        logger.info({ url: streamUrl.substring(0, 250) }, 'Found m3u8 URL in page HTML');
      }
    }

    // --- Estrategia 6: Buscar en scripts por URLs de streaming ---
    if (!streamUrl) {
      const scripts = $('script').toArray();
      for (const script of scripts) {
        const content = $(script).html() || '';
        if (content.length < 200000) {
          const urlMatch = content.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|ts|mp4|m3u)[^\s"'<>]*/i);
          if (urlMatch) {
            streamUrl = urlMatch[0];
            logger.info({ url: streamUrl.substring(0, 250) }, 'Found stream URL in script');
            break;
          }
        }
      }
    }

    if (!streamUrl) {
      logger.warn({ channel, url, capturedUrls }, 'No valid stream source found after rendering');
      return null;
    }

    // Extraer título del canal
    const title = $('h1').first().text().trim() ||
                 $('title').text().trim() ||
                 channel.replace(/-/g, ' ').toUpperCase();

    return { stream: streamUrl, title: title || channel };
  } catch (error: any) {
    logger.error({ error: error.message, channel }, 'Failed to fetch from chatytvgratis with Playwright');
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function extractChatyTvCloud(
  fetchUrl: string,
): Promise<{ stream: string; title: string } | null> {
  // Nivel 1: página del canal → iframe embed.php?id={id}
  const channelHtml = await fetchHTML(fetchUrl);
  const $ = cheerio.load(channelHtml);
  const title = $('h1').first().text().trim() || $('title').text().trim();

  const iframes: string[] = [];
  $('iframe').each((i, el) => {
    const raw = $(el).attr('src') || $(el).attr('data-src');
    if (!raw) return;
    const cleaned = raw.replace(/&amp;/g, '&');
    const full = cleaned.startsWith('http') ? cleaned : new URL(cleaned, fetchUrl).href;
    if (full.startsWith('http')) iframes.push(full);
  });
  if (iframes.length === 0) {
    logger.info({ fetchUrl }, 'chatytvgratis: sin iframes en la página del canal');
    return null;
  }
  const embedUrl = iframes.find((u) => u.includes('embed.php')) ||
                   iframes.find((u) => u.includes('tdtcloud')) ||
                   iframes.find((u) => u.includes('twitch.tv')) ||
                   iframes.find((u) => !isBlacklistedIframe(u)) ||
                   iframes[0];
  if (!embedUrl) return null;
  logger.info({ embedUrl: embedUrl.substring(0, 150) }, 'chatytvgratis: embed encontrado');

  // Player directo (Twitch, etc.): la página del player es el stream
  if (embedUrl.includes('twitch.tv') || embedUrl.includes('youtube.com')) {
    return { stream: embedUrl, title };
  }

  // Nivel 2: embed.php → {id}menu.php (onclick o iframe) o STREAM_URL directo
  const embedHtml = await fetchHTMLWithReferer(embedUrl, fetchUrl);
  const directStream = extractStreamFromHtml(embedHtml);
  if (directStream && await verifyStreamGet(directStream)) {
    logger.info({ url: directStream.substring(0, 120) }, 'chatytvgratis: STREAM_URL directo en embed');
    return { stream: directStream, title };
  }

  let targetUrl: string | null = null;
  const onclick = embedHtml.match(/location\.(?:replace|href)\(?\s*['"]([^'"]+\.php[^'"]*?)['"]/i);
  if (onclick) {
    targetUrl = onclick[1].startsWith('http') ? onclick[1] : new URL(onclick[1], embedUrl).href;
  } else {
    const embedIframe = embedHtml.match(/<iframe[^>]+(?:data-src|src)=["']([^"']+\.php[^'"]*?)["']/i);
    if (embedIframe) {
      targetUrl = embedIframe[1].replace(/&amp;/g, '&');
      if (!targetUrl.startsWith('http')) targetUrl = new URL(targetUrl, embedUrl).href;
    }
  }
  if (!targetUrl) {
    if (directStream) return { stream: directStream, title };
    logger.info({ embedUrl: embedUrl.substring(0, 120) }, 'chatytvgratis: sin target .php en embed');
    return null;
  }
  logger.info({ targetUrl: targetUrl.substring(0, 150) }, 'chatytvgratis: target .php encontrado');

  // Nivel 3: página target → STREAM_URL directo o fuentes (tabs/stage/iframes)
  const targetHtml = await fetchHTMLWithReferer(targetUrl, embedUrl);
  const directTarget = extractStreamFromHtml(targetHtml);
  if (directTarget && await verifyStreamGet(directTarget)) {
    return { stream: directTarget, title };
  }

  const $t = cheerio.load(targetHtml);
  const candidates: string[] = [];
  $t('#stage iframe, .stage iframe, iframe').each((i, el) => {
    const src = $t(el).attr('src') || $t(el).attr('data-src');
    if (src && !isBlacklistedIframe(src)) candidates.push(src.replace(/&amp;/g, '&'));
  });
  $t('[data-v]').each((i, el) => {
    const v = $t(el).attr('data-v');
    if (v) candidates.push(v.replace(/&amp;/g, '&'));
  });
  const resolved = candidates.map((c) => (c.startsWith('http') ? c : new URL(c, targetUrl).href));
  const unique = [...new Set(resolved)];
  logger.info({ sources: unique.map((u) => u.substring(0, 80)) }, 'chatytvgratis: fuentes en target');

  // Nivel 4: cada fuente → STREAM_URL; si no se puede reproducir standalone (requiere referer/token),
  // usar la página del player (si da 200) para que la app la embeba
  for (const candidate of unique) {
    try {
      const tabHtml = await fetchHTMLWithReferer(candidate, targetUrl);
      const stream = extractStreamFromHtml(tabHtml);
      if (stream && await verifyStreamGet(stream)) {
        return { stream, title };
      }
      try {
        const res = await httpClient.get(candidate, { timeout: 10000, headers: { Referer: targetUrl } });
        if (res.status === 200) {
          logger.info({ from: (stream || '').substring(0, 120), to: candidate.substring(0, 150) }, 'chatytvgratis: usando pagina del player (m3u8 no reproducible standalone)');
          return { stream: candidate, title };
        }
      } catch {
        // seguir con la siguiente fuente
      }
    } catch {
      // seguir con la siguiente fuente
    }
  }

  // Fallbacks finales: página target o embed (si dan 200)
  try {
    const res = await httpClient.get(targetUrl, { timeout: 8000, headers: { Referer: embedUrl } });
    if (res.status === 200) return { stream: targetUrl, title };
  } catch {
    // nada
  }
  try {
    const res = await httpClient.get(embedUrl, { timeout: 8000, headers: { Referer: fetchUrl } });
    if (res.status === 200) return { stream: embedUrl, title };
  } catch {
    // nada
  }
  return null;
}

function extractStreamFromHtml(html: string): string | null {
  const sv = html.match(/STREAM_URL\s*=\s*["']((?:https?:\\\/\\\/|https:\/\/)[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
  if (sv) return sv[1].replace(/\\\//g, '/');
  const escaped = html.match(/["']((?:https?:)?\\\/\\\/[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
  if (escaped) {
    let u = escaped[1].replace(/\\\//g, '/');
    if (!u.startsWith('http')) u = 'https:' + u;
    return u;
  }
  const plain = html.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/i);
  if (plain) return plain[0];
  return null;
}

async function verifyStreamUrl(testUrl: string): Promise<boolean> {
  try {
    const res = await httpClient.head(testUrl, {
      timeout: 10000,
      headers: {
        // El CDN de tvporinternet2 (playlist.php) solo acepta Chrome/120
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function verifyStreamGet(testUrl: string): Promise<boolean> {
  try {
    const res = await httpGetWithDnsRetry(testUrl, 8000);
    if (res.status !== 200) return false;
    const data = String(res.data || '');
    return data.startsWith('#EXTM3U') || data.includes('#EXT-X-');
  } catch {
    return false;
  }
}

async function verifyDash(testUrl: string): Promise<boolean> {
  try {
    const res = await httpGetWithDnsRetry(testUrl, 10000);
    if (res.status !== 200) return false;
    const data = String(res.data || '');
    return data.includes('<MPD') || /<mpd\b/i.test(data);
  } catch {
    return false;
  }
}

async function tryExtractWsDeportes(parameter: string, url: string, logType?: string): Promise<{ streamUrl?: string; hostPageUrl?: string } | null> {
  let streamUrl: string | undefined;
  let hostPageUrl: string | undefined;
  try {
    let pageUrl: string = url;
    let lastIframeUrl: string = '';
    for (let depth = 0; depth < 3 && pageUrl && !streamUrl; depth++) {
      const html = depth === 0 ? await fetchHTML(pageUrl) : await fetchHTMLWithReferer(pageUrl, url);
      elog(logType, `  Nivel ${depth + 1}: ${pageUrl}`);
      const streamUrlVar = html.match(/STREAM_URL\s*=\s*["']((?:https?:\\\/\\\/|https:\/\/)[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
      if (streamUrlVar) {
        streamUrl = streamUrlVar[1].replace(/\\\//g, '/');
        hostPageUrl = pageUrl;
        elog(logType, `  ✅ STREAM_URL en JS: ${streamUrl}`);
        break;
      }
      const escapedM3u8 = html.match(/["']((?:https?:)?\\\/\\\/[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
      if (escapedM3u8) {
        streamUrl = escapedM3u8[1].replace(/\\\//g, '/');
        if (!streamUrl.startsWith('http')) streamUrl = 'https:' + streamUrl;
        hostPageUrl = pageUrl;
        elog(logType, `  ✅ .m3u8 con slashes escapados: ${streamUrl}`);
        break;
      }
      const m3u8 = html.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/i);
      if (m3u8) {
        streamUrl = m3u8[0];
        hostPageUrl = pageUrl;
        elog(logType, `  ✅ .m3u8 en HTML: ${streamUrl}`);
        break;
      }
      const iframeSrc = html.match(/<iframe[^>]+(?:data-src|src)=["']([^"']+(?:player|core|stream|embed|tv)[^"']*)["']/i)?.[1] ||
                        html.match(/<iframe[^>]+data-src=["']([^"']+)["']/i)?.[1];
      if (iframeSrc) {
        lastIframeUrl = iframeSrc.replace(/&amp;/g, '&');
        if (!lastIframeUrl.startsWith('http')) lastIframeUrl = new URL(lastIframeUrl, pageUrl).href;
        pageUrl = lastIframeUrl;
        elog(logType, `  → iframe: ${pageUrl}`);
      } else {
        pageUrl = '';
      }
    }
    if (!streamUrl && lastIframeUrl) {
      streamUrl = lastIframeUrl;
      hostPageUrl = url;
    }
  } catch (e: any) {
    logger.error({ error: e.message, parameter }, 'HTTP extract failed for wsdeportes');
  }
  return streamUrl ? { streamUrl, hostPageUrl } : null;
}

async function extractWsDeportesWithPlaywright(browser: any, url: string, logType?: string): Promise<{ streamUrl?: string; m3u8HostFrameUrl?: string; cookies?: string } | null> {
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Interceptar peticiones de red para capturar URLs de streaming
    const capturedUrls: string[] = [];
    let m3u8HostFrameUrl: string | undefined;
    page.on('request', (request: any) => {
      const reqUrl = request.url();
      if (reqUrl.includes('.m3u8') || reqUrl.includes('.m3u') || reqUrl.includes('.ts') ||
          reqUrl.includes('mywebtv') || reqUrl.includes('tdtcloud') || reqUrl.includes('hls')) {
        capturedUrls.push(reqUrl);
        logger.info({ url: reqUrl.substring(0, 250) }, 'Captured streaming request from wsdeportes');
      }
      // Guardar la URL del frame que aloja el .m3u8 para usarla como Referer del proxy
      if (reqUrl.includes('.m3u8') || reqUrl.includes('.m3u')) {
        const frameUrl = request.frame()?.url?.();
        if (frameUrl && frameUrl !== 'about:blank' && frameUrl.startsWith('http') && !m3u8HostFrameUrl) {
          m3u8HostFrameUrl = frameUrl;
        }
      }
    });
    page.on('response', (response: any) => {
      const respUrl = response.url();
      if (respUrl.includes('.m3u8') || respUrl.includes('.m3u') || respUrl.includes('mywebtv') ||
          respUrl.includes('tdtcloud') || respUrl.includes('hls')) {
        if (!capturedUrls.includes(respUrl)) {
          capturedUrls.push(respUrl);
          logger.info({ url: respUrl.substring(0, 250) }, 'Captured streaming response from wsdeportes');
        }
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Intentar hacer clic en elementos que puedan iniciar el video/reproductor
    const clickSelectors = [
      'button',
      'a[href]',
      '[onclick]',
      '[class*="play"]',
      '[class*="repro"]',
      '[class*="ver"]',
      '.player',
      '#player',
      '.video-container',
      '.embed-responsive',
      '.entry-content a',
      '.post-content a',
      '.main a',
      '[class*="btn"]',
    ];

    for (const selector of clickSelectors) {
      try {
        const elements = await page.$$(selector);
        for (const el of elements) {
          const text = await el.textContent().catch(() => '');
          if (text && (text.toLowerCase().includes('ver') || text.toLowerCase().includes('repro') ||
              text.toLowerCase().includes('play') || text.toLowerCase().includes('online') ||
              text.toLowerCase().includes('canal') || text.toLowerCase().includes('aqui') ||
              text.toLowerCase().includes('accede') || text.toLowerCase().includes('ingresa'))) {
            logger.info({ selector, text: text.substring(0, 100) }, 'Clicking element with play-related text');
            await el.click().catch(() => {});
            await page.waitForTimeout(2000);
            break;
          }
        }
      } catch (e) {
        // ignore
      }
    }

    await page.waitForTimeout(4000);
    await page.close();

    // Preferir URLs .m3u8 capturadas por red
    const m3u8Url = capturedUrls.find((u) => u.includes('.m3u8') || u.includes('.m3u'));
    if (m3u8Url) {
      logger.info({ url: m3u8Url.substring(0, 250) }, 'Using captured m3u8 URL from wsdeportes');
      const cookies = await captureCookiesFromContext(context, m3u8Url);
      return { streamUrl: m3u8Url, m3u8HostFrameUrl, cookies };
    }
    const tdtStream = capturedUrls.find((u) => u.includes('tdtcloud') || u.includes('mywebtv'));
    if (tdtStream) {
      const cookies = await captureCookiesFromContext(context, tdtStream);
      return { streamUrl: tdtStream, m3u8HostFrameUrl, cookies };
    }
    return null;
  } catch (e: any) {
    logger.error({ error: e.message, url }, 'Playwright extraction failed for wsdeportes');
    return null;
  }
}

export async function getWsDeportes(parameter: string, logType?: string): Promise<LiveChannel | null> {
  const cacheKey = `wsdeportes:${parameter}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  let browser: any = null;
  try {
    const url = `${WSDEPORTES_BASE}/?v=${parameter}`;
    logger.info({ parameter, url }, 'Fetching channel from wsdeportes');
    elog(logType, `=== wsdeportes: ${parameter} ===`);
    elog(logType, `Consultando: ${url}`);

    let playwrightAvailable = true;
    try {
      await import('playwright');
      browser = await launchChromium();
    } catch (pwErr: any) {
      playwrightAvailable = false;
      logger.warn({ error: pwErr?.message, parameter }, 'Playwright no disponible, usando fallback HTTP');
      elog(logType, 'Playwright no disponible, usando fallback HTTP');
    }

    const opMatch = parameter.match(/^(.*?)&op=(\d+)$/);    const baseSlug = opMatch ? opMatch[1] : null;
    const currentOp = opMatch ? parseInt(opMatch[2]) : 0;
    const opsToTry = baseSlug && currentOp > 0 ? [currentOp, 1, 3].filter((v, i, a) => a.indexOf(v) === i) : [0];

    let streamUrl: string | null = null;
    let refererUrl: string = url;
    let streamCookies: string | undefined;

    for (const op of opsToTry) {
      const tryParam = baseSlug && op !== 0 ? baseSlug + (op !== 1 ? `&op=${op}` : '') : parameter;
      const tryUrl = `${WSDEPORTES_BASE}/?v=${tryParam}`;
      if (op !== 0) elog(logType, `  Probando op=${op}: ${tryUrl}`);

      // Estrategia 1: extracción HTTP (siempre disponible, sin navegador)
      const httpResult = await tryExtractWsDeportes(tryParam, tryUrl, logType);
      if (httpResult?.streamUrl) {
        streamUrl = httpResult.streamUrl;
        refererUrl = httpResult.hostPageUrl && httpResult.hostPageUrl.startsWith('http') ? httpResult.hostPageUrl : url;
        break;
      }

      // Estrategia 2: Playwright (solo si está disponible)
      if (playwrightAvailable && browser) {
        const pwResult = await extractWsDeportesWithPlaywright(browser, tryUrl, logType);
        if (pwResult?.streamUrl) {
          streamUrl = pwResult.streamUrl;
          refererUrl = pwResult.m3u8HostFrameUrl && pwResult.m3u8HostFrameUrl.startsWith('http') ? pwResult.m3u8HostFrameUrl : url;
          streamCookies = pwResult.cookies;
          break;
        }
      }
    }

    if (!streamUrl) {
      logger.warn({ parameter, url }, 'No valid stream source found on wsdeportes');
      elog(logType, '❌ No se encontró stream en wsdeportes');
      return null;
    }

    if (isM3u8Url(streamUrl)) {
      elog(logType, `🔒 Stream m3u8 directo puede dar 403 → proxy con Referer`);
      streamUrl = buildStreamProxyUrl(streamUrl, refererUrl, streamCookies);
    }

    // Verificación informativa (no bloquea el alta)
    const fullUrl = streamUrl.startsWith('http') ? streamUrl : `${env.PUBLIC_BASE_URL || ''}${streamUrl}`;
    try {
      const ok = await verifyStreamGet(fullUrl);
      elog(logType, ok ? `✅ Verificación OK vía proxy` : `⚠️ El stream no respondió en la verificación (se agrega igual)`);
    } catch (e: any) {
      elog(logType, `⚠️ Verificación falló: ${e.message} (se agrega igual)`);
    }

    elog(logType, `✅ URL final: ${streamUrl}`);

    const result: LiveChannel = {
      id: `live_${parameter}`,
      title: parameter.toUpperCase(),
      logo: undefined,
      group: 'Canales Deportivos',
      url: streamUrl,
      type: 'live',
      online: true,
      refreshUrl: url,
    };

    memoryCache.set(cacheKey, result, 3600000);
    return result;
  } catch (error: any) {
    logger.error({ error: error.message, parameter }, 'Failed to fetch from wsdeportes');
    elog(logType, `❌ Error: ${error.message}`);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function extractTvPorInternet2Http(url: string, logType?: string): Promise<{ streamUrl?: string; hostPageUrl?: string } | null> {
  try {
    let streamUrl: string | undefined;
    let pageUrl: string = url;
    let lastIframeUrl: string = '';
    let hostPageUrl: string | undefined;
    elog(logType, `  [tvporinternet2] URL canal: ${url}`);
    for (let depth = 0; depth < 4 && pageUrl && !streamUrl; depth++) {
      const html = depth === 0 ? await fetchHTML(pageUrl) : await fetchHTMLWithReferer(pageUrl, url);
      elog(logType, `  Nivel ${depth + 1}: ${pageUrl}`);
      const streamUrlVar = html.match(/STREAM_URL\s*=\s*["']((?:https?:\\\/\\\/|https:\/\/)[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
      if (streamUrlVar) {
        streamUrl = streamUrlVar[1].replace(/\\\//g, '/');
        hostPageUrl = pageUrl;
        elog(logType, `  ✅ STREAM_URL en JS: ${streamUrl}`);
        break;
      }
      const escapedM3u8 = html.match(/["']((?:https?:)?\\\/\\\/[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
      if (escapedM3u8) {
        streamUrl = escapedM3u8[1].replace(/\\\//g, '/');
        if (!streamUrl.startsWith('http')) streamUrl = 'https:' + streamUrl;
        hostPageUrl = pageUrl;
        elog(logType, `  ✅ .m3u8 con slashes escapados: ${streamUrl}`);
        break;
      }
      // Playlist viva (playlist.php?…&sig=…) del player: los .ts del CDN
      // caducan en segundos, este es el m3u8 real reproducible
      const playlistMatch = html.match(/["']((?:https?:)?\\\/\\\/[^"']+playlist\.php[^"']*?)["']/i) ||
                            html.match(/(https?:\/\/[^\s"'<>]+playlist\.php[^\s"'<>]*)/i);
      if (playlistMatch) {
        streamUrl = playlistMatch[1].replace(/\\\//g, '/');
        if (!streamUrl.startsWith('http')) streamUrl = 'https:' + streamUrl;
        hostPageUrl = pageUrl;
        elog(logType, `  ✅ playlist.php: ${streamUrl}`);
        break;
      }
      const m3u8 = html.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/i);
      if (m3u8) { streamUrl = m3u8[0]; hostPageUrl = pageUrl; elog(logType, `  ✅ .m3u8 nivel ${depth + 1}: ${streamUrl}`); break; }
      const fileMatch = html.match(/file["']?\s*:\s*["']([^"']+)["']/i);
      const srcMatch = html.match(/src["']?\s*:\s*["']([^"']+(?:m3u8|ts|mp4)[^"']*)["']/i);
      const sourceTag = html.match(/<source\s[^>]*src=["']([^"']+)["']/i);
      if (fileMatch) { streamUrl = fileMatch[1]; hostPageUrl = pageUrl; elog(logType, `  ✅ file: ${streamUrl}`); break; }
      if (srcMatch) { streamUrl = srcMatch[1]; hostPageUrl = pageUrl; elog(logType, `  ✅ src: ${streamUrl}`); break; }
      if (sourceTag) { streamUrl = sourceTag[1]; hostPageUrl = pageUrl; elog(logType, `  ✅ <source>: ${streamUrl}`); break; }
      const iframeSrc = html.match(/<iframe[^>]+(?:name|id)="?player"?[^>]+(?:data-src|src)=["']([^"']+)["']/i)?.[1] ||
                        html.match(/<iframe[^>]+(?:data-src|src)=["']([^"']+(?:player|core|stream|embed|tv)[^"']*)["']/i)?.[1] ||
                        html.match(/<iframe[^>]+data-src=["']([^"']+)["']/i)?.[1] ||
                        html.match(/<embed[^>]+src=["']([^"']+)["']/i)?.[1] ||
                        html.match(/<video[^>]+src=["']([^"']+)["']/i)?.[1];
      if (iframeSrc) {
        lastIframeUrl = iframeSrc.replace(/&amp;/g, '&');
        if (!lastIframeUrl.startsWith('http')) lastIframeUrl = new URL(lastIframeUrl, pageUrl).href;
        pageUrl = lastIframeUrl;
        elog(logType, `  → iframe: ${lastIframeUrl}`);
      } else {
        pageUrl = '';
      }
    }
    if (!streamUrl && lastIframeUrl) {
      streamUrl = lastIframeUrl;
      elog(logType, `  ⚠ Usando URL del último iframe: ${streamUrl}`);
    }
    return { streamUrl, hostPageUrl };
  } catch (fallbackErr: any) {
    logger.error({ error: fallbackErr.message }, 'HTTP fallback failed for tvporinternet2');
    elog(logType, `  ❌ Error extracción HTTP: ${fallbackErr.message}`);
    return null;
  }
}

export async function getTvPorInternet2(slug: string, option?: string, logType?: string): Promise<LiveChannel | null> {
  const cacheKey = `tvporinternet2:${slug}:${option || 'default'}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  let browser: any = null;
  try {
    const url = `${TVPORINTERNET2_BASE}/${slug}.php`;
    logger.info({ slug, url, option }, 'Fetching channel from tvporinternet2');
    elog(logType, `=== tvporinternet2: ${slug} ===`);
    elog(logType, `Consultando: ${url}`);

    let playwrightAvailable = true;
    try {
      await import('playwright');
      browser = await launchChromium();
    } catch (pwErr: any) {
      playwrightAvailable = false;
      logger.warn({ error: pwErr?.message, slug }, 'Playwright no disponible, usando fallback HTTP');
      elog(logType, 'Playwright no disponible, usando fallback HTTP');
    }

    if (!playwrightAvailable) {
      const httpResult = await extractTvPorInternet2Http(url, logType);
      if (!httpResult?.streamUrl) {
        logger.warn({ slug, url }, 'No valid stream source found on tvporinternet2');
        elog(logType, '❌ No se encontró stream en tvporinternet2');
        return null;
      }
      let streamUrl = httpResult.streamUrl;
      const refererUrl = (httpResult.hostPageUrl && httpResult.hostPageUrl.startsWith('http')) ? httpResult.hostPageUrl : url;
      if (streamUrl.includes('playlist.php') || isM3u8Url(streamUrl) || streamUrl.includes('.ts')) {
        elog(logType, `🔒 Stream protegido → proxy con Referer`);
        streamUrl = buildStreamProxyUrl(streamUrl, refererUrl);
      }
      elog(logType, `✅ URL final: ${streamUrl}`);
      const title = slug.replace(/-/g, ' ').replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
      const result: LiveChannel = {
        id: `live_${slug}`,
        title,
        logo: undefined,
        group: 'Canales TV',
        url: streamUrl,
        type: 'live',
        online: true,
        refreshUrl: url,
      };
      memoryCache.set(cacheKey, result, 3600000);
      return result;
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Interceptar peticiones de red para capturar URLs de streaming
    const capturedUrls: string[] = [];
    let streamHostFrameUrl: string | undefined;
    const isStreamUrl = (u: string) =>
      u.includes('playlist.php') || u.includes('.m3u8') || u.includes('.m3u') || u.includes('.ts') ||
      u.includes('mywebtv') || u.includes('tdtcloud') || u.includes('hls');
    page.on('request', (request: any) => {
      const reqUrl = request.url();
      if (isStreamUrl(reqUrl)) {
        capturedUrls.push(reqUrl);
      }
      // Guardar la URL del frame que aloja el stream (playlist m3u8 o .ts con token)
      // para usarla como Referer del proxy de streaming
      if (reqUrl.includes('playlist.php') || reqUrl.includes('.m3u8') || reqUrl.includes('.m3u') || reqUrl.includes('.ts')) {
        const frameUrl = request.frame()?.url?.();
        if (frameUrl && frameUrl !== 'about:blank' && frameUrl.startsWith('http') && !streamHostFrameUrl) {
          streamHostFrameUrl = frameUrl;
        }
      }
    });
    page.on('response', (response: any) => {
      const respUrl = response.url();
      if (isStreamUrl(respUrl)) {
        if (!capturedUrls.includes(respUrl)) {
          capturedUrls.push(respUrl);
        }
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Si se especificó una opción, buscar el botón exacto por su texto
    if (option) {
      const optionLower = option.toLowerCase();
      logger.info({ option }, 'Looking for option button');

      // Intentar encontrar el botón que contenga el texto de la opción
      const allButtons = await page.$$('button, a, [role="button"], .option-btn, [class*="opcion"], [class*="option"], [class*="tab"], [class*="btn"]');
      let clicked = false;
      for (const btn of allButtons) {
        const text = await btn.textContent().catch(() => '');
        if (text && text.toLowerCase().includes(optionLower)) {
          logger.info({ text: text.substring(0, 100) }, 'Found matching option button, clicking');
          await btn.click().catch(() => {});
          await page.waitForTimeout(3000);
          clicked = true;
          break;
        }
      }

      // Si no se encontró con selectores generales, buscar en todos los elementos
      if (!clicked) {
        const allElements = await page.$$('*');
        for (const el of allElements) {
          const text = await el.textContent().catch(() => '');
          if (text && text.toLowerCase().includes(optionLower)) {
            const tagName = await el.evaluate((node: any) => node.tagName).catch(() => '');
            logger.info({ tagName, text: text.substring(0, 100) }, 'Found matching element, clicking');
            await el.click().catch(() => {});
            await page.waitForTimeout(3000);
            break;
          }
        }
      }
    } else {
      // Intentar hacer clic en botones o enlaces relacionados con reproducción (default)
      const clickSelectors = [
        'button',
        'a[href]',
        '[onclick]',
        '[class*="play"]',
        '[class*="repro"]',
        '[class*="ver"]',
        '.player',
        '#player',
        '.video-container',
        '.embed-responsive',
        '.entry-content a',
        '.post-content a',
      ];
      for (const selector of clickSelectors) {
        try {
          const elements = await page.$$(selector);
          for (const el of elements) {
            const text = await el.textContent().catch(() => '');
            if (text && (text.toLowerCase().includes('ver') || text.toLowerCase().includes('repro') ||
                text.toLowerCase().includes('play') || text.toLowerCase().includes('online') ||
                text.toLowerCase().includes('canal') || text.toLowerCase().includes('aqui'))) {
              await el.click().catch(() => {});
              await page.waitForTimeout(2000);
              break;
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }

    // Esperar a que se cargue el nuevo contenido después del click
    await page.waitForTimeout(3000);

    // El player del iframe tarda en arrancar y disparar las peticiones de
    // stream (playlist.php / .ts / m3u8): esperar con tope hasta capturarlas
    const hasLiveStreamCapture = () =>
      capturedUrls.some((u) => u.includes('playlist.php') || u.includes('.ts') || u.includes('.m3u8') ||
        u.includes('.m3u') || u.includes('mywebtv') || u.includes('tdtcloud') || u.includes('hls'));
    for (let i = 0; i < 12 && !hasLiveStreamCapture(); i++) {
      await page.waitForTimeout(1000);
    }
    if (!hasLiveStreamCapture()) {
      logger.warn({ slug, captured: capturedUrls.length }, 'No live stream request captured from player frame');
      elog(logType, '⚠ No se capturaron peticiones de stream del player');
    }

    // Si el player no disparó peticiones desde el iframe (carga lenta, DNS...),
    // navegar directamente al iframe de video y esperar allí las del stream
    if (!hasLiveStreamCapture()) {
      const videoIframes = await page.$$('iframe');
      for (const f of videoIframes) {
        const src = await f.getAttribute('src').catch(() => null);
        if (src && src.includes('core.php')) {
          const iframeUrl = src.startsWith('http') ? src : new URL(src, url).href;
          elog(logType, `🔄 Sin capturas → navegando al iframe de video: ${iframeUrl}`);
          await page.goto(iframeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          for (let i = 0; i < 15 && !hasLiveStreamCapture(); i++) {
            await page.waitForTimeout(1000);
          }
          break;
        }
      }
    }

    const html = await page.content();
    const $ = cheerio.load(html);

    await page.close();

    // Log all iframes
    const allIframes = $('iframe');
    logger.info({ slug, iframeCount: allIframes.length }, 'All iframes found on tvporinternet2');
    allIframes.each((i, el) => {
      const src = $(el).attr('src') || 'no-src';
      const id = $(el).attr('id') || 'no-id';
      logger.info({ index: i, src: src.substring(0, 250), id }, `Iframe ${i}`);
    });

    let streamUrl: string | undefined;

    // Estrategia 1: URLs capturadas por red
    if (capturedUrls.length > 0) {
      const capturedMedia = capturedUrls.filter((u) => !isJunkStreamUrl(u));
      // El playlist.php (m3u8 vivo con tokens rotativos) es la fuente correcta:
      // los .ts sueltos son segmentos que caducan en segundos y NO sirven como URL.
      const playlistUrl = capturedMedia.find((u) => u.includes('playlist.php') || u.includes('.m3u8') || u.includes('.m3u'));
      const streamingUrl = capturedMedia.find((u) => u.includes('mywebtv') || u.includes('tdtcloud') || u.includes('hls'));
      streamUrl = playlistUrl || streamingUrl || capturedMedia[0];
      elog(logType, `✅ URL capturada por red: ${streamUrl}`);
      logger.info({ url: streamUrl.substring(0, 250), total: capturedMedia.length }, 'Using captured network URL');
    }

    // Estrategia 2: Buscar iframe de video real
    if (!streamUrl) {
      for (let i = 0; i < allIframes.length; i++) {
        const src = $(allIframes[i]).attr('src');
        if (!src || src === 'about:blank' || src.includes('jetpack') || src.includes('wordpress') ||
            src.includes('comment') || src.includes('disqus') || src.includes('facebook') ||
            src.includes('googleads') || src.includes('doubleclick') || src.includes('ads')) continue;

        const allow = $(allIframes[i]).attr('allow') || '';
        const allowfullscreen = $(allIframes[i]).attr('allowfullscreen') !== undefined;
        const hasVideoFeatures = allowfullscreen ||
          allow.includes('autoplay') ||
          allow.includes('encrypted-media') ||
          allow.includes('picture-in-picture');

        if (src.startsWith('http') && src.length > 10 && (hasVideoFeatures || src.includes('embed') || src.includes('player') || src.includes('tv'))) {
          streamUrl = src;
          elog(logType, `✅ iframe de video: ${src}`);
          logger.info({ src: src.substring(0, 250), allow }, 'Found video iframe');
          break;
        }
      }
    }

    // Estrategia 3: Cualquier iframe no-blacklisted
    if (!streamUrl) {
      for (let i = 0; i < allIframes.length; i++) {
        const src = $(allIframes[i]).attr('src');
        if (src && src.startsWith('http') && src.length > 10 && !src.includes('jetpack') &&
            !src.includes('wordpress') && !src.includes('comment') && !src.includes('googleads')) {
          streamUrl = src;
          elog(logType, `✅ iframe fallback: ${src}`);
          logger.info({ src: src.substring(0, 250) }, 'Found fallback iframe');
          break;
        }
      }
    }

    // Estrategia 4: Buscar URLs m3u8 en el HTML
    if (!streamUrl) {
      const bodyHtml = $.html();
      const m3u8Matches = bodyHtml.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/gi);
      if (m3u8Matches && m3u8Matches.length > 0) {
        streamUrl = m3u8Matches[0];
        elog(logType, `✅ .m3u8 en HTML: ${streamUrl}`);
        logger.info({ url: streamUrl.substring(0, 250) }, 'Found m3u8 URL in page HTML');
      }
    }

    // Estrategia 5: Buscar en scripts
    if (!streamUrl) {
      const scripts = $('script').toArray();
      for (const script of scripts) {
        const content = $(script).html() || '';
        if (content.length < 200000) {
          const urlMatch =
            content.match(/["']((?:https?:)?\\\/\\\/[^"']+playlist\.php[^"']*?)["']/i)?.[1] ||
            content.match(/https?:\/\/[^\s"'<>]+playlist\.php[^\s"'<>]*/i)?.[0] ||
            content.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|ts|mp4|m3u)[^\s"'<>]*/i)?.[0];
          if (urlMatch) {
            streamUrl = urlMatch.replace(/\\\//g, '/');
            if (streamUrl.startsWith('//')) streamUrl = 'https:' + streamUrl;
            elog(logType, `✅ URL en script: ${streamUrl}`);
            logger.info({ url: streamUrl.substring(0, 250) }, 'Found stream URL in script');
            break;
          }
        }
      }
    }

    if (!streamUrl) {
      const httpResult = await extractTvPorInternet2Http(url, logType);
      if (httpResult?.streamUrl) {
        streamUrl = httpResult.streamUrl;
      } else {
        logger.warn({ slug, url }, 'No valid stream source found on tvporinternet2');
        elog(logType, '❌ No se encontró stream en tvporinternet2');
        return null;
      }
      if (!await verifyStreamUrl(streamUrl)) {
        logger.warn({ url: streamUrl.substring(0, 120) }, 'Tvporinternet2 stream URL failed HEAD check, returning anyway');
      }
    }

    // tvporinternet2 protege sus streams (playlist.php, m3u8 y .ts con token)
    // con Referer/UA: si el stream es directo, servirlo por el proxy con el
    // Referer del frame que lo aloja y las cookies del contexto
    if (streamUrl && (streamUrl.includes('playlist.php') || isM3u8Url(streamUrl) || streamUrl.includes('.ts'))) {
      const refererUrl = (streamHostFrameUrl && streamHostFrameUrl.startsWith('http')) ? streamHostFrameUrl : url;
      const streamCookies = await captureCookiesFromContext(context, streamUrl);
      elog(logType, `🔒 Stream protegido → proxy con Referer: ${refererUrl}`);
      streamUrl = buildStreamProxyUrl(streamUrl, refererUrl, streamCookies);
    }
    elog(logType, `✅ URL final: ${streamUrl}`);

    // Extraer título (opcional, se usará el del body)
    const title = $('h1').first().text().trim() ||
                 $('title').text().trim() ||
                 slug.replace(/-/g, ' ').replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

    const result: LiveChannel = {
      id: `live_${slug}`,
      title: title || slug,
      logo: undefined,
      group: 'Canales TV',
      url: streamUrl,
      type: 'live',
      online: true,
      refreshUrl: url,
    };

    memoryCache.set(cacheKey, result, 3600000);
    return result;
  } catch (error: any) {
    logger.error({ error: error.message, slug }, 'Failed to fetch from tvporinternet2');
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

const CABLEVISIONHD_BASE = 'https://www.cablevisionhd.com';

function buildStreamProxyUrl(streamUrl: string, referer?: string, cookies?: string): string {
  const base = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('url', streamUrl);
  if (referer) params.set('referer', referer);
  const token = signCookies(cookies);
  if (token) params.set('cookies', token);
  return `${base}/proxy/stream?${params.toString()}`;
}

async function extractCablevisionHdHttp(url: string, logType?: string): Promise<{ streamUrl?: string; m3u8HostFrameUrl?: string } | null> {
  try {
    let streamUrl: string | undefined;
    let m3u8HostFrameUrl: string | undefined;
    let pageUrl: string = url;
    let lastIframeUrl: string = '';
    let fallbackHostUrl: string | undefined;
    elog(logType, `  [cablevisionhd] URL canal: ${url}`);
    for (let depth = 0; depth < 4 && pageUrl && !streamUrl; depth++) {
      const html = depth === 0 ? await fetchHTML(pageUrl) : await fetchHTMLWithReferer(pageUrl, url);
      elog(logType, `  Nivel ${depth + 1}: ${pageUrl}`);
      const streamUrlVar = html.match(/STREAM_URL\s*=\s*["']((?:https?:\\\/\\\/|https:\/\/)[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
      if (streamUrlVar) {
        streamUrl = streamUrlVar[1].replace(/\\\//g, '/');
        fallbackHostUrl = pageUrl;
        elog(logType, `  ✅ STREAM_URL en JS: ${streamUrl}`);
        logger.info({ url: streamUrl.substring(0, 150) }, 'Found STREAM_URL via HTTP fallback for cablevisionhd');
        break;
      }
      const escapedM3u8 = html.match(/["']((?:https?:)?\\\/\\\/[^"']+(?:\.m3u8|\.m3u|playlist\.php)[^"']*?)["']/i);
      if (escapedM3u8) {
        streamUrl = escapedM3u8[1].replace(/\\\//g, '/');
        if (!streamUrl.startsWith('http')) streamUrl = 'https:' + streamUrl;
        fallbackHostUrl = pageUrl;
        elog(logType, `  ✅ .m3u8 escapado: ${streamUrl}`);
        logger.info({ url: streamUrl.substring(0, 150) }, 'Found escaped m3u8 via HTTP fallback for cablevisionhd');
        break;
      }
      const m3u8 = html.match(/https?:\/\/[^\s"'<>]+(?:\.m3u8|\.m3u|playlist\.php)[^\s"'<>]*/i);
      if (m3u8) { streamUrl = m3u8[0]; fallbackHostUrl = pageUrl; elog(logType, `  ✅ .m3u8 nivel ${depth + 1}: ${streamUrl}`); logger.info({ url: streamUrl.substring(0, 150) }, 'Found m3u8 via HTTP fallback for cablevisionhd'); break; }
      const fileMatch = html.match(/file["']?\s*:\s*["']([^"']+)["']/i);
      const srcMatch = html.match(/src["']?\s*:\s*["']([^"']+(?:m3u8|ts|mp4)[^"']*)["']/i);
      const sourceTag = html.match(/<source\s[^>]*src=["']([^"']+)["']/i);
      if (fileMatch) { streamUrl = fileMatch[1]; fallbackHostUrl = pageUrl; elog(logType, `  ✅ file: ${streamUrl}`); logger.info({}, 'Found file: via HTTP fallback'); break; }
      if (srcMatch) { streamUrl = srcMatch[1]; fallbackHostUrl = pageUrl; elog(logType, `  ✅ src: ${streamUrl}`); logger.info({}, 'Found src: via HTTP fallback'); break; }
      if (sourceTag) { streamUrl = sourceTag[1]; fallbackHostUrl = pageUrl; elog(logType, `  ✅ <source>: ${streamUrl}`); logger.info({}, 'Found source tag via HTTP fallback'); break; }
      const iframeSrc = html.match(/<iframe[^>]+(?:name|id)="?player"?[^>]+(?:data-src|src)=["']([^"']+)["']/i)?.[1] ||
                        html.match(/<iframe[^>]+(?:data-src|src)=["']([^"']+(?:player|core|stream|embed|tv)[^"']*)["']/i)?.[1] ||
                        html.match(/<iframe[^>]+data-src=["']([^"']+)["']/i)?.[1] ||
                        html.match(/<embed[^>]+src=["']([^"']+)["']/i)?.[1] ||
                        html.match(/<video[^>]+src=["']([^"']+)["']/i)?.[1];
      if (iframeSrc) {
        lastIframeUrl = iframeSrc.replace(/&amp;/g, '&');
        if (!lastIframeUrl.startsWith('http')) lastIframeUrl = new URL(lastIframeUrl, pageUrl).href;
        pageUrl = lastIframeUrl;
        elog(logType, `  → iframe: ${lastIframeUrl}`);
      } else {
        pageUrl = '';
      }
    }
    if (!streamUrl && lastIframeUrl) {
      streamUrl = lastIframeUrl;
      elog(logType, `  ⚠ Usando URL del último iframe: ${streamUrl}`);
    }
    if (streamUrl && !m3u8HostFrameUrl) m3u8HostFrameUrl = fallbackHostUrl;
    return { streamUrl, m3u8HostFrameUrl };
  } catch (fallbackErr: any) {
    logger.error({ error: fallbackErr.message }, 'HTTP fallback failed for cablevisionhd');
    elog(logType, `  ❌ Error extracción HTTP: ${fallbackErr.message}`);
    return null;
  }
}

export async function getCablevisionHd(slug: string, option?: string, logType?: string): Promise<LiveChannel | null> {
  const cacheKey = `cablevisionhd:${slug}:${option || 'default'}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  let browser: any = null;
  try {
    const url = `${CABLEVISIONHD_BASE}/${slug}.php`;
    logger.info({ slug, url, option }, 'Fetching channel from cablevisionhd');
    elog(logType, `=== cablevisionhd: ${slug} ===`);
    elog(logType, `Consultando: ${url}`);

    let playwrightAvailable = true;
    try {
      await import('playwright');
      browser = await launchChromium();
    } catch (pwErr: any) {
      playwrightAvailable = false;
      logger.warn({ error: pwErr?.message, slug }, 'Playwright no disponible, usando fallback HTTP');
      elog(logType, 'Playwright no disponible, usando fallback HTTP');
    }

    if (!playwrightAvailable) {
      const httpResult = await extractCablevisionHdHttp(url, logType);
      if (!httpResult?.streamUrl) {
        logger.warn({ slug, url }, 'No valid stream source found on cablevisionhd');
        elog(logType, '❌ No se encontró stream en cablevisionhd');
        return null;
      }
      const proxyUrl = buildStreamProxyUrl(httpResult.streamUrl, httpResult.m3u8HostFrameUrl || url);
      elog(logType, `✅ URL final: ${proxyUrl}`);
      const result: LiveChannel = {
        id: `live_${slug}`,
        title: slug.replace(/-/g, ' ').replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
        logo: undefined,
        group: 'Canales TV',
        url: proxyUrl,
        type: 'live',
        online: true,
        refreshUrl: url,
      };
      memoryCache.set(cacheKey, result, 3600000);
      return result;
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Interceptar peticiones de red para capturar URLs de streaming
    const capturedUrls: string[] = [];
    let m3u8HostFrameUrl: string | undefined;
    page.on('request', (request: any) => {
      const reqUrl = request.url();
      if (reqUrl.includes('.m3u8') || reqUrl.includes('.m3u') || reqUrl.includes('.ts') ||
          reqUrl.includes('mywebtv') || reqUrl.includes('tdtcloud') || reqUrl.includes('hls') ||
          reqUrl.includes('playlist.php')) {
        capturedUrls.push(reqUrl);
      }
      // Guardar la URL del frame que aloja el .m3u8 (nivel 3) para usarla si el .m3u8 da 403
      if (reqUrl.includes('.m3u8') || reqUrl.includes('.m3u') || reqUrl.includes('playlist.php')) {
        const frameUrl = request.frame()?.url?.();
        if (frameUrl && frameUrl !== 'about:blank' && frameUrl.startsWith('http') && !m3u8HostFrameUrl) {
          m3u8HostFrameUrl = frameUrl;
        }
      }
    });
    page.on('response', (response: any) => {
      const respUrl = response.url();
      if (respUrl.includes('.m3u8') || respUrl.includes('.m3u') || respUrl.includes('mywebtv') ||
          respUrl.includes('tdtcloud') || respUrl.includes('hls') || respUrl.includes('playlist.php')) {
        if (!capturedUrls.includes(respUrl)) {
          capturedUrls.push(respUrl);
        }
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Si se especificó una opción, buscar el botón exacto por su texto
    if (option) {
      const optionLower = option.toLowerCase();
      logger.info({ option }, 'Looking for option button on cablevisionhd');

      const allButtons = await page.$$('button, a, [role="button"], .option-btn, [class*="opcion"], [class*="option"], [class*="tab"], [class*="btn"], li, span, div');
      let clicked = false;
      for (const btn of allButtons) {
        const text = await btn.textContent().catch(() => '');
        if (text && text.toLowerCase().includes(optionLower)) {
          logger.info({ text: text.substring(0, 100) }, 'Found matching option button, clicking');
          await btn.click().catch(() => {});
          await page.waitForTimeout(3000);
          clicked = true;
          break;
        }
      }

      // Si no se encontró, buscar en todos los elementos
      if (!clicked) {
        const allElements = await page.$$('*');
        for (const el of allElements) {
          const text = await el.textContent().catch(() => '');
          if (text && text.toLowerCase().includes(optionLower)) {
            const tagName = await el.evaluate((node: any) => node.tagName).catch(() => '');
            logger.info({ tagName, text: text.substring(0, 100) }, 'Found matching element, clicking');
            await el.click().catch(() => {});
            await page.waitForTimeout(3000);
            break;
          }
        }
      }
    } else {
      // Intentar hacer clic en botones o enlaces relacionados con reproducción (default)
      const clickSelectors = [
        'button',
        'a[href]',
        '[onclick]',
        '[class*="play"]',
        '[class*="repro"]',
        '[class*="ver"]',
        '.player',
        '#player',
        '.video-container',
        '.embed-responsive',
        '.entry-content a',
        '.post-content a',
      ];
      for (const selector of clickSelectors) {
        try {
          const elements = await page.$$(selector);
          for (const el of elements) {
            const text = await el.textContent().catch(() => '');
            if (text && (text.toLowerCase().includes('ver') || text.toLowerCase().includes('repro') ||
                text.toLowerCase().includes('play') || text.toLowerCase().includes('online') ||
                text.toLowerCase().includes('canal') || text.toLowerCase().includes('aqui'))) {
              await el.click().catch(() => {});
              await page.waitForTimeout(2000);
              break;
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }

    // Esperar a que se cargue el nuevo contenido después del click
    await page.waitForTimeout(3000);

    const html = await page.content();
    const $ = cheerio.load(html);

    await page.close();

    // Log all iframes
    const allIframes = $('iframe');
    logger.info({ slug, iframeCount: allIframes.length }, 'All iframes found on cablevisionhd');
    allIframes.each((i, el) => {
      const src = $(el).attr('src') || 'no-src';
      const id = $(el).attr('id') || 'no-id';
      logger.info({ index: i, src: src.substring(0, 250), id }, `Iframe ${i}`);
    });

    let streamUrl: string | undefined;

    logger.info({ slug, totalCaptured: capturedUrls.length, iframeCount: allIframes.length }, `Diagnóstico cablevisionhd: ${slug}`);

    // Estrategia 1: URLs capturadas por red
    if (capturedUrls.length > 0) {
      logger.info({ capturedUrls }, 'URLs capturadas por red');
      const capturedMedia = capturedUrls.filter((u) => !isJunkStreamUrl(u));
      // Preferir manifiestos sobre segmentos: .m3u8/.m3u explícitos, luego
      // playlist.php (el CDN regionales.saohgdasregions.fun genera el manifiesto
      // sin extensión .m3u8), luego URLs tipo hls, y solo como último recurso un
      // segmento .ts (su token caduca en segundos → URL muerta al guardarla).
      const m3u8Url = capturedMedia.find((u) => u.includes('.m3u8') || u.includes('.m3u'));
      const playlistPhpUrl = capturedMedia.find((u) => u.includes('playlist.php'));
      const streamingUrl = capturedMedia.find((u) => u.includes('mywebtv') || u.includes('tdtcloud') || u.includes('hls'));
      streamUrl = m3u8Url || playlistPhpUrl || streamingUrl || capturedMedia[0];
      if (streamUrl) logger.info({ url: streamUrl.substring(0, 250), total: capturedMedia.length }, 'Usando URL capturada por red');
    } else {
      logger.info({}, 'No se capturaron URLs de red');
    }

    // Estrategia 2: Buscar iframe de video real
    if (!streamUrl) {
      logger.info({ iframeCount: allIframes.length }, 'Buscando iframe con características de video');
      for (let i = 0; i < allIframes.length; i++) {
        const src = $(allIframes[i]).attr('src');
        if (!src || src === 'about:blank' || src.includes('jetpack') || src.includes('wordpress') ||
            src.includes('comment') || src.includes('disqus') || src.includes('facebook') ||
            src.includes('googleads') || src.includes('doubleclick') || src.includes('ads')) {
          logger.info({ i, src: src?.substring(0, 100) }, '  iframe saltado (blacklist)');
          continue;
        }

        const allow = $(allIframes[i]).attr('allow') || '';
        const allowfullscreen = $(allIframes[i]).attr('allowfullscreen') !== undefined;
        const hasVideoFeatures = allowfullscreen ||
          allow.includes('autoplay') ||
          allow.includes('encrypted-media') ||
          allow.includes('picture-in-picture');

        logger.info({ i, src: src?.substring(0, 150), allow: allow?.substring(0, 80), hasVideoFeatures }, '  iframe evaluado');

        if (src.startsWith('http') && src.length > 10 && (hasVideoFeatures || src.includes('embed') || src.includes('player') || src.includes('tv'))) {
          streamUrl = src;
          logger.info({ src: src.substring(0, 250), allow }, '✅ Iframe con video encontrado');
          break;
        }
      }
      if (!streamUrl) logger.info({}, 'No se encontró iframe con video');
    }

    // Estrategia 3: Cualquier iframe no-blacklisted
    if (!streamUrl) {
      logger.info({}, 'Buscando cualquier iframe no-blacklisted');
      for (let i = 0; i < allIframes.length; i++) {
        const src = $(allIframes[i]).attr('src');
        if (src && src.startsWith('http') && src.length > 10 && !src.includes('jetpack') &&
            !src.includes('wordpress') && !src.includes('comment') && !src.includes('googleads')) {
          streamUrl = src;
          logger.info({ src: src.substring(0, 250) }, '✅ Fallback iframe encontrado');
          break;
        }
      }
      if (!streamUrl) logger.info({}, 'No se encontró iframe fallback');
    }

    // Estrategia 4: Buscar URLs m3u8 en el HTML
    if (!streamUrl) {
      const bodyHtml = $.html();
      const m3u8Matches = bodyHtml.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/gi);
      logger.info({ total: m3u8Matches?.length || 0 }, 'Buscando .m3u8 en HTML');
      if (m3u8Matches && m3u8Matches.length > 0) {
        streamUrl = m3u8Matches[0];
        logger.info({ url: streamUrl.substring(0, 250) }, '✅ .m3u8 encontrado en HTML');
      }
    }

    // Estrategia 5: Buscar en scripts
    if (!streamUrl) {
      logger.info({ scriptCount: $('script').length }, 'Buscando en scripts');
      const scripts = $('script').toArray();
      for (const script of scripts) {
        const content = $(script).html() || '';
        if (content.length < 200000) {
          const urlMatch = content.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|ts|mp4|m3u)[^\s"'<>]*/i);
          if (urlMatch) {
            streamUrl = urlMatch[0];
            logger.info({ url: streamUrl.substring(0, 250) }, '✅ URL encontrada en script');
            break;
          }
        }
      }
      if (!streamUrl) logger.info({}, 'No se encontró URL en scripts');
    }

    if (!streamUrl) {
      const httpResult = await extractCablevisionHdHttp(url, logType);
      if (httpResult?.streamUrl) {
        streamUrl = httpResult.streamUrl;
        m3u8HostFrameUrl = httpResult.m3u8HostFrameUrl;
      } else {
        logger.warn({ slug, url }, 'No valid stream source found on cablevisionhd');
        elog(logType, '❌ No se encontró stream en cablevisionhd');
        return null;
      }
    }

    // Nivel-3 fallback: cablevisionhd protege sus .m3u8 con Referer, así que siempre
    // servimos el stream a través del proxy de streaming con el Referer del frame que lo aloja
    if (streamUrl) {
      const refererUrl = (m3u8HostFrameUrl && m3u8HostFrameUrl.startsWith('http')) ? m3u8HostFrameUrl : url;
      const streamCookies = await captureCookiesFromContext(context, streamUrl);
      const proxyUrl = buildStreamProxyUrl(streamUrl, refererUrl, streamCookies);
      elog(logType, `🔒 Stream m3u8 directo puede dar 403 → proxy con Referer: ${refererUrl}`);
      logger.info({ from: streamUrl.substring(0, 150), to: proxyUrl.substring(0, 200) }, 'cablevisionhd: usando proxy de streaming con Referer');
      streamUrl = proxyUrl;
    }
    elog(logType, `✅ URL final: ${streamUrl}`);

    // Extraer título (opcional)
    const title = $('h1').first().text().trim() ||
                 $('title').text().trim() ||
                 slug.replace(/-/g, ' ').replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

    const result: LiveChannel = {
      id: `live_${slug}`,
      title: title || slug,
      logo: undefined,
      group: 'Canales TV',
      url: streamUrl,
      type: 'live',
      online: true,
      refreshUrl: url,
    };

    memoryCache.set(cacheKey, result, 3600000);
    return result;
  } catch (error: any) {
    logger.error({ error: error.message, slug }, 'Failed to fetch from cablevisionhd');
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function extractSenalColombia(url: string, logType?: string): Promise<string | null> {
  try {
    elog(logType, `  Nivel 1: ${url}`);
    const html = await fetchHTML(url);

    // envivosrc:"https:\/\/media.rtvc.gov.co\/kalturartvc\/indexSC.html"
    const envivoMatch = html.match(/envivosrc"\s*:\s*"([^"]+?)"/i);
    if (envivoMatch) {
      let playerUrl = envivoMatch[1].replace(/\\\//g, '/');
      if (playerUrl.startsWith('//')) playerUrl = 'https:' + playerUrl;
      elog(logType, `  → player Kaltura: ${playerUrl}`);
      const playerHtml = await fetchHTMLWithReferer(playerUrl, url);
      const m3u8Match = playerHtml.match(/https?:\/\/[^"'\s<>]+\.(?:m3u8|m3u)[^"'\s<>]*/i);
      if (m3u8Match) {
        elog(logType, `  ✅ .m3u8 en player: ${m3u8Match[0]}`);
        return m3u8Match[0];
      }
    }

    const directMatch = html.match(/https?:\/\/[^"'\s<>]+\.(?:m3u8|m3u)[^"'\s<>]*/i);
    if (directMatch) {
      elog(logType, `  ✅ .m3u8 en página: ${directMatch[0]}`);
      return directMatch[0];
    }

    logger.warn({ url }, 'No m3u8 found on senalcolombia, usando fallback');
    elog(logType, `  ⚠ Usando URL conocida de Señal Colombia`);
    return SENALCOLOMBIA_STREAM_FALLBACK;
  } catch (e: any) {
    logger.error({ error: e.message, url }, 'HTTP extract failed for senalcolombia');
    return SENALCOLOMBIA_STREAM_FALLBACK;
  }
}

export async function getSenalColombia(slug: string, logType?: string): Promise<LiveChannel | null> {
  const cacheKey = `senalcolombia:${slug}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  const url = `${SENALCOLOMBIA_BASE}/${slug}`;
  logger.info({ slug, url }, 'Fetching channel from senalcolombia');
  elog(logType, `=== senalcolombia: ${slug} ===`);
  elog(logType, `Consultando: ${url}`);

  const streamUrl = await extractSenalColombia(url, logType);
  if (!streamUrl) {
    logger.warn({ slug, url }, 'No valid stream source found on senalcolombia');
    elog(logType, '❌ No se encontró stream en senalcolombia');
    return null;
  }

  // Stream público y estable, pero se sirve vía proxy por CORS/consistencia
  const proxied = buildStreamProxyUrl(streamUrl, url);
  elog(logType, `✅ URL final: ${proxied}`);

  const result: LiveChannel = {
    id: `live_${slug}`,
    title: slug.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
    logo: undefined,
    group: 'Canales TV',
    url: proxied,
    type: 'live',
    online: true,
    refreshUrl: url,
    proveedor: 'senalcolombia',
  };

  memoryCache.set(cacheKey, result, 3600000);
  return result;
}

const VERTVCABLE_BASE = 'https://www.vertvcable.com';

const VERTV_DNS_ERRORS = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'];

async function httpGetWithDnsRetry(testUrl: string, timeout: number, headers?: Record<string, string>): Promise<any> {
  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await httpClient.get(testUrl, {
        timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ...headers,
        },
      });
    } catch (err: any) {
      lastErr = err;
      const code = err?.code || err?.cause?.code;
      if (!VERTV_DNS_ERRORS.includes(code)) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

async function fetchHtmlWithRetry(url: string, referer?: string, logType?: string): Promise<string> {
  let lastErr: any;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      if (referer) return await fetchHTMLWithReferer(url, referer);
      return await fetchHTML(url);
    } catch (err: any) {
      lastErr = err;
      const code = err?.code || err?.cause?.code;
      if (!VERTV_DNS_ERRORS.includes(code)) throw err;
      elog(logType, `  ⚠ DNS/red inestable (${code}), reintento ${attempt}/4...`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

async function fetchVertvPageWithRetry(url: string, logType?: string): Promise<string> {
  return fetchHtmlWithRetry(url, undefined, logType);
}

interface VertvPill {
  index: string;
  post: string;
  nonce: string;
  type: string;
}

function extractVertvPills(html: string): VertvPill[] {
  const pills: VertvPill[] = [];
  const buttonRe = /<[^>]+data-post="(\d+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = buttonRe.exec(html)) !== null) {
    const tag = m[0];
    const post = m[1];
    const nonce = tag.match(/data-nonce="([a-f0-9]+)"/i)?.[1];
    const index = tag.match(/data-index="(\d+)"/i)?.[1];
    const type = tag.match(/data-type="([^"]+)"/i)?.[1];
    if (nonce && index !== undefined && type) {
      pills.push({ index, post, nonce, type });
    }
  }
  // Ordenar por índice y deduplicar por post+index
  pills.sort((a, b) => Number(a.index) - Number(b.index));
  return pills.filter((p, i, arr) => arr.findIndex((x) => x.post === p.post && x.index === p.index) === i);
}

interface VertvResolvedStream {
  streamUrl: string;
  referer?: string;
  drm?: LiveChannel['drm'];
}

/**
 * Parsea el JSON `const config = {...}` que el player de vertvcable incrusta
 * en la página /ver/?id=X. Escaneo por llaves balanceadas (no regex simple,
 * por si el JSON es multilinea).
 */
function extractVertvConfig(html: string): Record<string, unknown> | null {
  const marker = 'const config = ';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = idx + marker.length;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Canales EMBED de vertvcable: el AJAX devuelve una página de player
 * (play.vertvcable.com/play/?canal=X) que embebe un iframe /ver/?id=X, y esa
 * página trae el config del stream (`url` + `clearkey` para DASH cifrado).
 */
async function resolveVertvEmbedUrl(embedUrl: string, channelPageUrl: string, logType?: string): Promise<VertvResolvedStream | null> {
  const playHtml = await fetchHtmlWithRetry(embedUrl, channelPageUrl, logType);
  const iframeSrc = playHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
  if (!iframeSrc) {
    const playM3u8 = playHtml.match(/["'](https?:\/\/[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
    if (playM3u8) return { streamUrl: playM3u8[1], referer: embedUrl };
    return null;
  }
  const verUrl = new URL(iframeSrc, embedUrl).toString();
  const verHtml = await fetchHtmlWithRetry(verUrl, embedUrl, logType);
  const config = extractVertvConfig(verHtml);
  const rawUrl = config?.url;
  if (!rawUrl || typeof rawUrl !== 'string') {
    // Algunos configs EMBED pueden ser HLS directamente
    const verM3u8 = verHtml.match(/["'](https?:\/\/[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
    if (verM3u8) return { streamUrl: verM3u8[1], referer: verUrl };
    return null;
  }
  const streamUrl = rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl;
  let drm: LiveChannel['drm'];
  const clearKey = config.clearkey;
  if (clearKey && typeof clearKey === 'object') {
    const entries = Object.entries(clearKey as Record<string, unknown>);
    if (entries.length > 0) {
      const [keyId, key] = entries[0];
      if (typeof keyId === 'string' && typeof key === 'string') {
        drm = { type: 'clearkey', keyId, key };
      }
    }
  }
  return { streamUrl, referer: verUrl, drm };
}

async function resolveVertvPillUrl(pill: VertvPill, pageUrl: string, logType?: string): Promise<VertvResolvedStream | null> {
  let res: any;
  try {
    res = await httpClient.post(
      'https://www.vertvcable.com/wp-admin/admin-ajax.php',
      new URLSearchParams({
        action: 'vtc_get_stream_url',
        post_id: pill.post,
        stream_index: pill.index,
        nonce: pill.nonce,
      }),
      {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': pageUrl,
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
    );
  } catch (err: any) {
    const code = err?.code || err?.cause?.code;
    if (VERTV_DNS_ERRORS.includes(code)) {
      // DNS local inestable: reintento
      res = await httpClient.post(
        'https://www.vertvcable.com/wp-admin/admin-ajax.php',
        new URLSearchParams({
          action: 'vtc_get_stream_url',
          post_id: pill.post,
          stream_index: pill.index,
          nonce: pill.nonce,
        }),
        {
          timeout: 25000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': pageUrl,
            'X-Requested-With': 'XMLHttpRequest',
          },
        },
      );
    } else {
      throw err;
    }
  }
  const data = res.data?.data || res.data;
  if (!res.data?.success && !data?.url) return null;
  let streamUrl: string | undefined = data?.url;
  if (!streamUrl || typeof streamUrl !== 'string') return null;
  streamUrl = streamUrl.trim();
  if (pill.type.toUpperCase() === 'EMBED' && !isM3u8Url(streamUrl)) {
    return resolveVertvEmbedUrl(streamUrl, pageUrl, logType);
  }
  return { streamUrl };
}

/**
 * VerTV Cable: extrae la URL del stream vía AJAX de WordPress (action
 * vtc_get_stream_url) usando el post_id/nonce de la página del canal.
 * No requiere navegador. Los streams son playlists HLS (p. ej. bozztv) que
 * se sirven proxeados con referer/UA.
 */
export async function getVertvCable(slug: string, option?: string, logType?: string): Promise<LiveChannel | null> {
  const cacheKey = `vertvcable:${slug}:${option || 'default'}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  const url = `${VERTVCABLE_BASE}/${slug}/`;
  logger.info({ slug, url, option }, 'Fetching channel from vertvcable');
  elog(logType, `=== vertvcable: ${slug} ===`);
  elog(logType, `Consultando: ${url}`);

  let html: string;
  try {
    html = await fetchVertvPageWithRetry(url, logType);
  } catch (err: any) {
    elog(logType, `❌ Error obteniendo página: ${err?.message}`);
    return null;
  }

  const pills = extractVertvPills(html);
  if (pills.length === 0) {
    elog(logType, '❌ No se encontraron pills de stream (data-post/data-nonce)');
    logger.warn({ slug, url }, 'No stream pills found on vertvcable page');
    return null;
  }
  elog(logType, `✅ Pills encontradas: ${pills.length} (${pills.map((p) => `[${p.index}] ${p.type}`).join(', ')})`);

  const wanted = option !== undefined ? Number(option) : 0;
  const ordered = pills.some((p) => Number(p.index) === wanted) ? pills : pills.slice(wanted) || pills;

  let streamUrl: string | null = null;
  let streamReferer: string | undefined;
  let streamDrm: LiveChannel['drm'];
  for (const pill of ordered) {
    elog(logType, `  ▶ Intento pill [${pill.index}] tipo ${pill.type} (post ${pill.post})`);
    try {
      const resolved = await resolveVertvPillUrl(pill, url, logType);
      if (!resolved) {
        elog(logType, `  ❌ Pill [${pill.index}] sin URL en AJAX`);
        continue;
      }
      const sUrl = resolved.streamUrl;
      const isDash = sUrl.toLowerCase().includes('.mpd') || /^DASH$/i.test(pill.type);
      const isHls = isM3u8Url(sUrl) || /^HLS$/i.test(pill.type);
      const ok = isDash ? await verifyDash(sUrl) : isHls ? await verifyStreamGet(sUrl) : await verifyStreamUrl(sUrl);
      if (!ok) {
        elog(logType, `  ❌ Pill [${pill.index}] URL no verificada (forbidden/error)`);
        continue;
      }
      streamUrl = sUrl;
      streamReferer = resolved.referer;
      streamDrm = resolved.drm;
      elog(logType, `  ✅ Stream [${pill.index}]: ${sUrl.substring(0, 150)}${streamDrm ? ' (DASH + ClearKey)' : ''}`);
      break;
    } catch (pillErr: any) {
      elog(logType, `  ❌ Pill [${pill.index}] error: ${pillErr?.message}`);
    }
  }

  if (!streamUrl) {
    logger.warn({ slug, url }, 'No valid stream found on vertvcable');
    elog(logType, '❌ No se encontró stream en vertvcable');
    return null;
  }

  const proxied = buildStreamProxyUrl(streamUrl, streamReferer || VERTVCABLE_BASE + '/');
  elog(logType, `✅ URL final: ${proxied}`);

  const result: LiveChannel = {
    id: `live_${slug}`,
    title: slug.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
    logo: undefined,
    group: 'Canales TV',
    url: proxied,
    type: 'live',
    online: true,
    refreshUrl: url,
    refreshOption: option || undefined,
    proveedor: 'vertvcable',
    ...(streamDrm ? { drm: streamDrm } : {}),
  };

  memoryCache.set(cacheKey, result, 3600000);
  return result;
}

export async function getChannelStream(source: 'chatytv' | 'wsdeportes' | 'tvporinternet2' | 'cablevisionhd' | 'senalcolombia' | 'vertvcable', parameter: string, option?: string, logType?: string): Promise<LiveChannel | null> {
  let result: LiveChannel | null = null;
  if (source === 'chatytv') {
    result = await getChatytv(parameter, logType);
  } else if (source === 'wsdeportes') {
    result = await getWsDeportes(parameter, logType);
  } else if (source === 'tvporinternet2') {
    result = await getTvPorInternet2(parameter, option, logType);
  } else if (source === 'cablevisionhd') {
    result = await getCablevisionHd(parameter, option, logType);
  } else if (source === 'senalcolombia') {
    result = await getSenalColombia(parameter, logType);
  } else if (source === 'vertvcable') {
    result = await getVertvCable(parameter, option, logType);
  }

  if (!result) return null;
  if (result.url && isJunkStreamUrl(result.url)) {
    elog(logType, `❌ URL de stream inválida (script/CDN): ${result.url.substring(0, 120)}`);
    logger.warn({ url: result.url.substring(0, 250), source, parameter }, 'Descartando URL de stream inválida');
    return null;
  }
  return result;
}
