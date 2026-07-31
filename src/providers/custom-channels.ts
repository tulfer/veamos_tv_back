import * as cheerio from 'cheerio';
import { fetchHTML, fetchHTMLWithReferer, httpClient } from '../utils/http';
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
    const { chromium: playwrightChromium } = await import('playwright');
browser = await playwrightChromium.launch({ headless: true });
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

async function verifyStreamUrl(testUrl: string): Promise<boolean> {
  try {
    const res = await httpClient.head(testUrl, { timeout: 10000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function tryExtractWsDeportes(parameter: string, url: string): Promise<string | null> {
  let streamUrl: string | null = null;
  try {
    let pageUrl: string = url;
    let lastIframeUrl: string = '';
    for (let depth = 0; depth < 3 && pageUrl && !streamUrl; depth++) {
      const html = depth === 0 ? await fetchHTML(pageUrl) : await fetchHTMLWithReferer(pageUrl, url);
      const streamUrlVar = html.match(/STREAM_URL\s*=\s*["']((?:https?:\\\/\\\/|https:\/\/)[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
      if (streamUrlVar) { streamUrl = streamUrlVar[1].replace(/\\\//g, '/'); break; }
      const escapedM3u8 = html.match(/["']((?:https?:)?\\\/\\\/[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
      if (escapedM3u8) {
        streamUrl = escapedM3u8[1].replace(/\\\//g, '/');
        if (!streamUrl.startsWith('http')) streamUrl = 'https:' + streamUrl;
        break;
      }
      const m3u8 = html.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/i);
      if (m3u8) { streamUrl = m3u8[0]; break; }
      const iframeSrc = html.match(/<iframe[^>]+(?:data-src|src)=["']([^"']+(?:player|core|stream|embed|tv))[^"']*["']/i)?.[1] ||
                        html.match(/<iframe[^>]+data-src=["']([^"']+)["']/i)?.[1];
      if (iframeSrc) {
        lastIframeUrl = iframeSrc.replace(/&amp;/g, '&');
        if (!lastIframeUrl.startsWith('http')) lastIframeUrl = new URL(lastIframeUrl, pageUrl).href;
        pageUrl = lastIframeUrl;
      } else {
        pageUrl = '';
      }
    }
    if (!streamUrl && lastIframeUrl) streamUrl = lastIframeUrl;
  } catch (e: any) {
    logger.error({ error: e.message, parameter }, 'HTTP extract failed for wsdeportes');
  }
  return streamUrl;
}

export async function getWsDeportes(parameter: string): Promise<LiveChannel | null> {
  const cacheKey = `wsdeportes:${parameter}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  let browser: any = null;
  try {
    const url = `${WSDEPORTES_BASE}/?v=${parameter}`;
    logger.info({ parameter, url }, 'Fetching channel from wsdeportes with Playwright');

    const { chromium: playwrightChromium } = await import('playwright');
browser = await playwrightChromium.launch({ headless: true });
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
        logger.info({ url: reqUrl.substring(0, 250) }, 'Captured streaming request from wsdeportes');
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
    await page.waitForTimeout(5000);

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

    // Esperar más tiempo para que carguen los iframes dinámicos
    await page.waitForTimeout(5000);

    const html = await page.content();
    const $ = cheerio.load(html);

    await page.close();

    // Log todos los iframes para debug
    const allIframes = $('iframe');
    logger.info({ parameter, iframeCount: allIframes.length }, 'All iframes found on wsdeportes');
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
      logger.info({ url: streamUrl.substring(0, 250), total: capturedUrls.length }, 'Using captured network URL from wsdeportes');
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
          logger.info({ src: src.substring(0, 250), allow }, 'Found video iframe on wsdeportes');
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
          logger.info({ src: src.substring(0, 250) }, 'Found fallback iframe on wsdeportes');
          break;
        }
      }
    }

    // Estrategia 4: Buscar URLs m3u8 en el HTML completo
    if (!streamUrl) {
      const bodyHtml = $.html();
      const m3u8Matches = bodyHtml.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/gi);
      if (m3u8Matches && m3u8Matches.length > 0) {
        streamUrl = m3u8Matches[0];
        logger.info({ url: streamUrl.substring(0, 250) }, 'Found m3u8 URL in page HTML on wsdeportes');
      }
    }

    // Estrategia 5: Buscar en scripts por URLs de streaming
    if (!streamUrl) {
      const scripts = $('script').toArray();
      for (const script of scripts) {
        const content = $(script).html() || '';
        if (content.length < 200000) {
          const urlMatch = content.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|ts|mp4|m3u)[^\s"'<>]*/i);
          if (urlMatch) {
            streamUrl = urlMatch[0];
            logger.info({ url: streamUrl.substring(0, 250) }, 'Found stream URL in script on wsdeportes');
            break;
          }
        }
      }
    }

    if (!streamUrl) {
      logger.warn({ parameter, url, capturedUrls }, 'No valid stream source found on wsdeportes via Playwright, trying HTTP fallback');
      streamUrl = await tryExtractWsDeportes(parameter, url);
    }

    // Verificar la URL del stream y hacer fallback por opciones si no funciona
    if (!streamUrl) {
      logger.warn({ parameter, url }, 'No valid stream source found on wsdeportes');
      return null;
    }

    const opMatch = parameter.match(/^(.*?)&op=(\d+)$/);
    const baseSlug = opMatch ? opMatch[1] : null;
    const currentOp = opMatch ? parseInt(opMatch[2]) : 0;
    let verifiedUrl: string | null = null;

    if (baseSlug && currentOp > 0) {
      const opsToTry = [currentOp, 1, 3].filter((v, i, a) => a.indexOf(v) === i); // current first, then 1, 3
      for (const op of opsToTry) {
        if (op === currentOp) {
          if (await verifyStreamUrl(streamUrl)) {
            verifiedUrl = streamUrl;
            logger.info({ op, url: streamUrl.substring(0, 120) }, 'Stream URL verified OK');
            break;
          }
          logger.warn({ op, url: streamUrl.substring(0, 120) }, 'Stream URL failed, trying next op');
        } else {
          const newParam = baseSlug + (op !== 1 ? `&op=${op}` : '');
          const newUrl = `${WSDEPORTES_BASE}/?v=${newParam}`;
          logger.info({ op, url: newUrl }, 'Trying alternative op via HTTP extraction');
          const extracted = await tryExtractWsDeportes(newParam, newUrl);
          if (extracted && await verifyStreamUrl(extracted)) {
            verifiedUrl = extracted;
            logger.info({ op, url: extracted.substring(0, 120) }, 'Alternative op stream URL verified OK');
            break;
          }
        }
      }
    } else {
      if (await verifyStreamUrl(streamUrl)) {
        verifiedUrl = streamUrl;
      }
    }

    if (!verifiedUrl) {
      logger.warn({ parameter, url }, 'No working stream URL found on wsdeportes after trying all ops');
      return null;
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
      url: verifiedUrl,
      type: 'live',
      online: true,
      refreshUrl: url,
    };

    memoryCache.set(cacheKey, result, 3600000);
    return result;
  } catch (error: any) {
    logger.error({ error: error.message, parameter }, 'Failed to fetch from wsdeportes with Playwright');
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export async function getTvPorInternet2(slug: string, option?: string): Promise<LiveChannel | null> {
  const cacheKey = `tvporinternet2:${slug}:${option || 'default'}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  let browser: any = null;
  try {
    const url = `${TVPORINTERNET2_BASE}/${slug}.html`;
    logger.info({ slug, url, option }, 'Fetching channel from tvporinternet2');

    const { chromium: playwrightChromium } = await import('playwright');
browser = await playwrightChromium.launch({ headless: true });
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
      logger.warn({ slug, url, capturedUrls }, 'No valid stream source found on tvporinternet2 via Playwright, trying HTTP fallback');
      try {
        let pageUrl: string = url;
        let lastIframeUrl: string = '';
        for (let depth = 0; depth < 4 && pageUrl && !streamUrl; depth++) {
          const html = depth === 0 ? await fetchHTML(pageUrl) : await fetchHTMLWithReferer(pageUrl, url);
          const streamUrlVar = html.match(/STREAM_URL\s*=\s*["']((?:https?:\\\/\\\/|https:\/\/)[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
          if (streamUrlVar) {
            streamUrl = streamUrlVar[1].replace(/\\\//g, '/');
            logger.info({ url: streamUrl.substring(0, 150) }, 'Found STREAM_URL via HTTP fallback for tvporinternet2');
            break;
          }
          const escapedM3u8 = html.match(/["']((?:https?:)?\\\/\\\/[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
          if (escapedM3u8) {
            streamUrl = escapedM3u8[1].replace(/\\\//g, '/');
            if (!streamUrl.startsWith('http')) streamUrl = 'https:' + streamUrl;
            logger.info({ url: streamUrl.substring(0, 150) }, 'Found escaped m3u8 via HTTP fallback for tvporinternet2');
            break;
          }
          const m3u8 = html.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/i);
          if (m3u8) { streamUrl = m3u8[0]; logger.info({ url: streamUrl.substring(0, 150) }, 'Found m3u8 via HTTP fallback for tvporinternet2'); break; }
          const fileMatch = html.match(/file["']?\s*:\s*["']([^"']+)["']/i);
          const srcMatch = html.match(/src["']?\s*:\s*["']([^"']+(?:m3u8|ts|mp4)[^"']*)["']/i);
          const sourceTag = html.match(/<source\s[^>]*src=["']([^"']+)["']/i);
          if (fileMatch) { streamUrl = fileMatch[1]; logger.info({}, 'Found file: via HTTP fallback'); break; }
          if (srcMatch) { streamUrl = srcMatch[1]; logger.info({}, 'Found src: via HTTP fallback'); break; }
          if (sourceTag) { streamUrl = sourceTag[1]; logger.info({}, 'Found source tag via HTTP fallback'); break; }
          const iframeSrc = html.match(/<iframe[^>]+(?:name|id)="?player"?[^>]+(?:data-src|src)=["']([^"']+)["']/i)?.[1] ||
                            html.match(/<iframe[^>]+(?:data-src|src)=["']([^"']+(?:player|core|stream|embed|tv))[^"']*["']/i)?.[1] ||
                            html.match(/<iframe[^>]+data-src=["']([^"']+)["']/i)?.[1] ||
                            html.match(/<embed[^>]+src=["']([^"']+)["']/i)?.[1] ||
                            html.match(/<video[^>]+src=["']([^"']+)["']/i)?.[1];
          if (iframeSrc) {
            lastIframeUrl = iframeSrc.replace(/&amp;/g, '&');
            if (!lastIframeUrl.startsWith('http')) lastIframeUrl = new URL(lastIframeUrl, pageUrl).href;
            pageUrl = lastIframeUrl;
          } else {
            pageUrl = '';
          }
        }
        if (!streamUrl && lastIframeUrl) streamUrl = lastIframeUrl;
      } catch (fallbackErr: any) {
        logger.error({ error: fallbackErr.message }, 'HTTP fallback failed for tvporinternet2');
      }
      if (!streamUrl) {
        logger.warn({ slug, url }, 'No valid stream source found on tvporinternet2');
        return null;
      }
      if (!await verifyStreamUrl(streamUrl)) {
        logger.warn({ url: streamUrl.substring(0, 120) }, 'Tvporinternet2 stream URL failed HEAD check, returning anyway');
      }
    }

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

export async function getCablevisionHd(slug: string, option?: string): Promise<LiveChannel | null> {
  const cacheKey = `cablevisionhd:${slug}:${option || 'default'}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  let browser: any = null;
  try {
    const url = `${CABLEVISIONHD_BASE}/${slug}.php`;
    logger.info({ slug, url, option }, 'Fetching channel from cablevisionhd');

    const { chromium: playwrightChromium } = await import('playwright');
browser = await playwrightChromium.launch({ headless: true });
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
      const m3u8Url = capturedUrls.find((u) => u.includes('.m3u8') || u.includes('.m3u'));
      const streamingUrl = capturedUrls.find((u) => u.includes('mywebtv') || u.includes('tdtcloud') || u.includes('hls'));
      streamUrl = m3u8Url || streamingUrl || capturedUrls[0];
      if (streamUrl) logger.info({ url: streamUrl.substring(0, 250), total: capturedUrls.length }, 'Usando URL capturada por red');
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
      logger.warn({ slug, url, capturedUrls, iframeCount: allIframes.length }, 'No valid stream source found on cablevisionhd via Playwright, trying HTTP fallback');
      try {
        let pageUrl: string = url;
        let lastIframeUrl: string = '';
        for (let depth = 0; depth < 4 && pageUrl && !streamUrl; depth++) {
          const html = depth === 0 ? await fetchHTML(pageUrl) : await fetchHTMLWithReferer(pageUrl, url);
          const streamUrlVar = html.match(/STREAM_URL\s*=\s*["']((?:https?:\\\/\\\/|https:\/\/)[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
          if (streamUrlVar) {
            streamUrl = streamUrlVar[1].replace(/\\\//g, '/');
            logger.info({ url: streamUrl.substring(0, 150) }, 'Found STREAM_URL via HTTP fallback for cablevisionhd');
            break;
          }
          const escapedM3u8 = html.match(/["']((?:https?:)?\\\/\\\/[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
          if (escapedM3u8) {
            streamUrl = escapedM3u8[1].replace(/\\\//g, '/');
            if (!streamUrl.startsWith('http')) streamUrl = 'https:' + streamUrl;
            logger.info({ url: streamUrl.substring(0, 150) }, 'Found escaped m3u8 via HTTP fallback for cablevisionhd');
            break;
          }
          const m3u8 = html.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/i);
          if (m3u8) { streamUrl = m3u8[0]; logger.info({ url: streamUrl.substring(0, 150) }, 'Found m3u8 via HTTP fallback for cablevisionhd'); break; }
          const fileMatch = html.match(/file["']?\s*:\s*["']([^"']+)["']/i);
          const srcMatch = html.match(/src["']?\s*:\s*["']([^"']+(?:m3u8|ts|mp4)[^"']*)["']/i);
          const sourceTag = html.match(/<source\s[^>]*src=["']([^"']+)["']/i);
          if (fileMatch) { streamUrl = fileMatch[1]; logger.info({}, 'Found file: via HTTP fallback'); break; }
          if (srcMatch) { streamUrl = srcMatch[1]; logger.info({}, 'Found src: via HTTP fallback'); break; }
          if (sourceTag) { streamUrl = sourceTag[1]; logger.info({}, 'Found source tag via HTTP fallback'); break; }
          const iframeSrc = html.match(/<iframe[^>]+(?:name|id)="?player"?[^>]+(?:data-src|src)=["']([^"']+)["']/i)?.[1] ||
                            html.match(/<iframe[^>]+(?:data-src|src)=["']([^"']+(?:player|core|stream|embed|tv))[^"']*["']/i)?.[1] ||
                            html.match(/<iframe[^>]+data-src=["']([^"']+)["']/i)?.[1] ||
                            html.match(/<embed[^>]+src=["']([^"']+)["']/i)?.[1] ||
                            html.match(/<video[^>]+src=["']([^"']+)["']/i)?.[1];
          if (iframeSrc) {
            lastIframeUrl = iframeSrc.replace(/&amp;/g, '&');
            if (!lastIframeUrl.startsWith('http')) lastIframeUrl = new URL(lastIframeUrl, pageUrl).href;
            pageUrl = lastIframeUrl;
          } else {
            pageUrl = '';
          }
        }
        if (!streamUrl && lastIframeUrl) streamUrl = lastIframeUrl;
      } catch (fallbackErr: any) {
        logger.error({ error: fallbackErr.message }, 'HTTP fallback failed for cablevisionhd');
      }
      if (!streamUrl) {
        logger.warn({ slug, url }, 'No valid stream source found on cablevisionhd');
        return null;
      }
      // Verify the stream URL works
      if (!await verifyStreamUrl(streamUrl)) {
        logger.warn({ url: streamUrl.substring(0, 120) }, 'Cablevisionhd stream URL failed HEAD check, returning anyway');
      }
    }

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

export async function getChannelStream(source: 'chatytv' | 'wsdeportes' | 'tvporinternet2' | 'cablevisionhd', parameter: string, option?: string): Promise<LiveChannel | null> {
  if (source === 'chatytv') {
    return getChatytv(parameter);
  } else if (source === 'wsdeportes') {
    return getWsDeportes(parameter);
  } else if (source === 'tvporinternet2') {
    return getTvPorInternet2(parameter, option);
  } else if (source === 'cablevisionhd') {
    return getCablevisionHd(parameter, option);
  }
  return null;
}
