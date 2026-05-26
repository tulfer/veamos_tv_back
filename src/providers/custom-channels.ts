import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { fetchHTML } from '../utils/http';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { LiveChannel } from '../types';

const CHATYTVGRATIS_BASE = 'https://www.chatytvgratis.net';
const WSDEPORTES_BASE = 'https://wsdeportes.net';

export async function getChatytv(channel: string): Promise<LiveChannel | null> {
  const cacheKey = `chatytv:${channel}`;
  const cached = memoryCache.get<LiveChannel>(cacheKey);
  if (cached) return cached;

  let browser: any = null;
  try {
    const url = `${CHATYTVGRATIS_BASE}/${channel}/`;
    
    // Usar Playwright para renderizar JavaScript
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Navegar a la página
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    
    // Esperar un poco para que todo cargue
    await page.waitForTimeout(2000);
    
    // Obtener el HTML renderizado
    const html = await page.content();
    const $ = cheerio.load(html);
    
    await page.close();

    // Buscar iframe de reproductor
    let iframeSrc: string | undefined;
    
    // Intenta múltiples selectores - buscar iframes que no sean about:blank
    const allIframes = $('iframe');
    for (let i = 0; i < allIframes.length; i++) {
      const src = $(allIframes[i]).attr('src');
      if (src && src !== 'about:blank' && src.length > 10) {
        // Preferir iframes con patrones de streaming
        if (src.includes('embed') || src.includes('stream') || src.includes('video') || src.includes('tdtcloud') || src.includes('hls')) {
          iframeSrc = src;
          break;
        }
        // Si no tiene patrón específico pero es una URL válida, guardar como fallback
        if (!iframeSrc && src.startsWith('http')) {
          iframeSrc = src;
        }
      }
    }
    
    // Si aún no hay src, buscar en atributos data-src o fuentes en video tags
    if (!iframeSrc) {
      const videoElement = $('video').first();
      if (videoElement) {
        const src = videoElement.attr('src') || videoElement.find('source').first().attr('src');
        if (src) iframeSrc = src;
      }
    }
    
    // Última opción: buscar en scripts por URLs de streaming
    if (!iframeSrc) {
      const scripts = $('script').toArray();
      for (const script of scripts) {
        const content = $(script).html() || '';
        if (content.length < 100000) {
          // Buscar m3u8 URLs o streaming sources
          const urlMatch = content.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|ts|mp4|m3u)[^\s"'<>]*/i);
          if (urlMatch) {
            iframeSrc = urlMatch[0];
            break;
          }
        }
      }
    }
    
    if (!iframeSrc || iframeSrc === 'about:blank') {
      logger.warn({ channel, url }, 'No valid iframe or stream source found after rendering');
      return null;
    }

    // Extraer título del canal
    const title = $('h1').first().text().trim() || 
                 $('title').text().trim() || 
                 channel.replace(/-/g, ' ').toUpperCase();

    const result: LiveChannel = {
      id: `chatytv_${channel}`,
      title: title || channel,
      logo: undefined,
      group: 'Canales TV',
      url: iframeSrc,
      type: 'live',
      online: true,
    };

    memoryCache.set(cacheKey, result, 3600000);
    return result;
  } catch (error) {
    logger.error({ error, channel }, 'Failed to fetch from chatytvgratis with Playwright');
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
    // Primero intentamos obtener de data-src o src del video
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
      id: `wsdeportes_${parameter}`,
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

export async function getChannelStream(source: 'chatytv' | 'wsdeportes', parameter: string): Promise<LiveChannel | null> {
  if (source === 'chatytv') {
    return getChatytv(parameter);
  } else if (source === 'wsdeportes') {
    return getWsDeportes(parameter);
  }
  return null;
}
