import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { fetchHTML } from '../utils/http';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { LiveChannel } from '../types';

const CHATYTVGRATIS_BASE = 'https://www.chatytvgratis.net';
const WSDEPORTES_BASE = 'https://wsdeportes.net';
const TVPORINTERNET2_BASE = 'https://www.tvporinternet2.com';

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

export async function getChatytv(channel: string): Promise<LiveChannel | null> {
  const cacheKey = `chatytv:${channel}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  let browser: any = null;
  try {
    const url = `${CHATYTVGRATIS_BASE}/${channel}/`;
    logger.info({ channel, url }, 'Fetching channel from chatytvgratis');

    // Usar Playwright para renderizar JavaScript
    browser = await chromium.launch({ headless: true });
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
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

    // Esperar a que cargue el contenido
    await page.waitForTimeout(3000);

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
          const href = await el.getAttribute('href').catch(() => '');
          const innerHtml = await el.innerHTML().catch(() => '');
          
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
      const m3u8Url = capturedUrls.find((u) => u.includes('.m3u8') || u.includes('.m3u'));
      const streamingUrl = capturedUrls.find((u) => u.includes('mywebtv') || u.includes('tdtcloud') || u.includes('hls'));
      streamUrl = m3u8Url || streamingUrl || capturedUrls[0];
      logger.info({ url: streamUrl.substring(0, 250), total: capturedUrls.length }, 'Using captured network URL');
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

    const result: LiveChannel = {
      id: `live_${channel}`,
      title: title || channel,
      logo: undefined,
      group: 'Canales TV',
      url: streamUrl,
      type: 'live',
      online: true,
    };

    memoryCache.set(cacheKey, result, 3600000);
    return result;
  } catch (error: any) {
    logger.error({ error: error.message, channel }, 'Failed to fetch from chatytvgratis with Playwright');
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export async function getWsDeportes(parameter: string): Promise<LiveChannel | null> {
  const cacheKey = `wsdeportes:${parameter}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${WSDEPORTES_BASE}/?v=${parameter}`;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    // Buscar la URL del stream HLS del reproductor
    let streamUrl: string | undefined;

    // Buscar en etiquetas script por la configuración del reproductor
    const scripts = $('script').toArray();
    for (const script of scripts) {
      const content = $(script).html() || '';
      // Buscar URL HLS en el contenido del script
      const hlsMatch = content.match(/https?:\/\/[^\s"'<>]+\.m3u8/);
      if (hlsMatch) {
        streamUrl = hlsMatch[0];
        break;
      }
      // Buscar también URLs de streaming genéricas
      const streamMatch = content.match(/https?:\/\/[^\s"'<>]*mywebtv[^\s"'<>]+/);
      if (streamMatch) {
        streamUrl = streamMatch[0];
        break;
      }
    }

    // Si no encontramos URL en scripts, construir la URL conocida
    if (!streamUrl) {
      streamUrl = `https://w1327.mywebtv.cloud/hls/${parameter}/`;
    }

    // Extraer título
    const title = $('h1').first().text().trim() ||
                 $('title').text().trim() ||
                 parameter.toUpperCase();

    const result: LiveChannel = {
      id: `live_${parameter}`,
      title: title || parameter,
      logo: undefined,
      group: 'Canales Deportivos',
      url: streamUrl,
      type: 'live',
      online: true,
    };

    memoryCache.set(cacheKey, result, 3600000);
    return result;
  } catch (error) {
    logger.error({ error, parameter }, 'Failed to fetch from wsdeportes');
    return null;
  }
}

export async function getTvPorInternet2(slug: string): Promise<LiveChannel | null> {
  const cacheKey = `tvporinternet2:${slug}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  let browser: any = null;
  try {
    const url = `${TVPORINTERNET2_BASE}/${slug}.html`;
    logger.info({ slug, url }, 'Fetching channel from tvporinternet2');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Interceptar peticiones de red para capturar URLs de streaming
    const capturedUrls: string[] = [];
    page.on('request', (request: any) => {
      const reqUrl = request.url();
      if (reqUrl.includes('.m3u8') || reqUrl.includes('.m3u') || reqUrl.includes('.ts') ||
          reqUrl.includes('mywebtv') || reqUrl.includes('tdtcloud') || reqUrl.includes('hls')) {
        capturedUrls.push(reqUrl);
      }
    });
    page.on('response', (response: any) => {
      const respUrl = response.url();
      if (respUrl.includes('.m3u8') || respUrl.includes('.m3u') || respUrl.includes('mywebtv') ||
          respUrl.includes('tdtcloud') || respUrl.includes('hls')) {
        if (!capturedUrls.includes(respUrl)) {
          capturedUrls.push(respUrl);
        }
      }
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Intentar hacer clic en botones o enlaces relacionados con reproducción
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

    await page.waitForTimeout(3000);

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
      const m3u8Url = capturedUrls.find((u) => u.includes('.m3u8') || u.includes('.m3u'));
      const streamingUrl = capturedUrls.find((u) => u.includes('mywebtv') || u.includes('tdtcloud') || u.includes('hls'));
      streamUrl = m3u8Url || streamingUrl || capturedUrls[0];
      logger.info({ url: streamUrl.substring(0, 250), total: capturedUrls.length }, 'Using captured network URL');
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
        logger.info({ url: streamUrl.substring(0, 250) }, 'Found m3u8 URL in page HTML');
      }
    }

    // Estrategia 5: Buscar en scripts
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
      logger.warn({ slug, url, capturedUrls }, 'No valid stream source found on tvporinternet2');
      return null;
    }

    // Extraer título
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

export async function getChannelStream(source: 'chatytv' | 'wsdeportes' | 'tvporinternet2', parameter: string): Promise<LiveChannel | null> {
  if (source === 'chatytv') {
    return getChatytv(parameter);
  } else if (source === 'wsdeportes') {
    return getWsDeportes(parameter);
  } else if (source === 'tvporinternet2') {
    return getTvPorInternet2(parameter);
  }
  return null;
}
