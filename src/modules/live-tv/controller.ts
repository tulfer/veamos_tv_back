import { FastifyRequest, FastifyReply } from 'fastify';
import { fetchLiveChannels, getChannelsByGroup, getChannelsByCountry, getChannelGroups } from '../../providers/live-tv';
import { getChannelStream } from '../../providers/custom-channels';
import { getCachedOrFetch, memoryCache } from '../../cache';
import { loadSyncData, saveSyncData, loadChannels } from '../../services/data-store';
import { LiveChannel } from '../../types';
import { logger } from '../../utils/logger';
import { startSync, completeSync, failSync, updateSyncProgress, pushLog, clearLogs } from '../../services/sync-status';
import { fetchHTML, fetchHTMLWithReferer, httpClient } from '../../utils/http';

const CACHE_KEY = 'live:channels';
const PAGE_SIZE = 10;

/**
 * Extrae el parámetro `expires` de la URL del stream (tokens de m3u8).
 * Acepta tanto la URL directa como la URL del proxy (donde el m3u8 está
 * codificado en el query param `url`).
 */
function extractExpiration(url?: string): { expires?: number; expiresDate?: string } {
  if (!url) return {};
  let target = url;
  try {
    if (url.includes('/proxy/stream')) {
      const parsed = new URL(url, 'http://localhost');
      const inner = parsed.searchParams.get('url');
      if (inner) target = inner;
    }
  } catch {
    // ignore
  }
  const match = target.match(/[?&](?:expires|exp)=(\d+)/i);
  if (!match) return {};
  const ts = Number(match[1]);
  if (!Number.isFinite(ts) || ts < 1000000000) return {};
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return {};
  return {
    expires: ts,
    expiresDate: date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
  };
}

/** Calcula y guarda expires/expiresDate en el canal a partir de su url. */
function applyExpiration(ch: LiveChannel): void {
  const exp = extractExpiration(ch.url);
  ch.expires = exp.expires;
  ch.expiresDate = exp.expiresDate;
}

const inflightRefresh = new Map<string, Promise<string | null>>();
const lastRefreshAttempt = new Map<string, number>();
const REFRESH_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * Re-extrae el stream de un canal cuya URL expiró (el m3u8 devolvió 4xx).
 * Busca el canal por la URL interna del proxy, vuelve a consultar al proveedor,
 * guarda la URL nueva vigente y devuelve la nueva url del proxy (o null).
 * Evita refrescos concurrentes para la misma URL y aplica un cooldown de 2 min
 * para no bombardear al proveedor si el canal sigue caído.
 */
export async function refreshExpiredChannelUrl(targetUrl: string): Promise<string | null> {
  const now = Date.now();
  const last = lastRefreshAttempt.get(targetUrl);
  if (last && now - last < REFRESH_COOLDOWN_MS) return null;
  lastRefreshAttempt.set(targetUrl, now);

  const existing = inflightRefresh.get(targetUrl);
  if (existing) return existing;
  const task = doRefreshExpiredChannel(targetUrl).finally(() => inflightRefresh.delete(targetUrl));
  inflightRefresh.set(targetUrl, task);
  return task;
}

async function doRefreshExpiredChannel(targetUrl: string): Promise<string | null> {
  try {
    const synced = await loadSyncData();
    if (!synced || !Array.isArray(synced.channels)) return null;

    const ch = synced.channels.find((c) => {
      if (!c?.url || !c.url.includes('/proxy/stream')) return false;
      try {
        const u = new URL(c.url, 'http://localhost');
        return u.searchParams.get('url') === targetUrl;
      } catch {
        return false;
      }
    });

    if (!ch) {
      logger.warn({ url: targetUrl.substring(0, 120) }, 'Stream expirado sin canal correspondiente, no se puede refrescar');
      return null;
    }

    const source = (ch.proveedor as any) || extractRefreshSource(ch.refreshUrl);
    if (!source || !ch.refreshUrl) {
      logger.warn({ id: ch.id }, 'Canal expirado sin proveedor/refreshUrl, no se puede refrescar');
      return null;
    }

    const slug = extractSlugFromUrl(ch.refreshUrl, source);
    if (!slug) {
      logger.warn({ id: ch.id, refreshUrl: ch.refreshUrl }, 'No se pudo extraer slug para refrescar canal expirado');
      return null;
    }

    pushLog('addChannel', `🔁 URL expirada detectada por proxy → refrescando ${ch.id}...`);
    memoryCache.del(`${source}:${slug}`);
    memoryCache.del(`${source}:${slug}:default`);
    if (ch.refreshOption) memoryCache.del(`${source}:${slug}:${ch.refreshOption}`);

    const result = await getChannelStream(source, slug, ch.refreshOption || undefined);
    if (!result?.url) {
      pushLog('addChannel', `❌ No se pudo refrescar ${ch.id} (el proveedor no devolvió URL)`);
      return null;
    }

    ch.url = result.url;
    applyExpiration(ch);
    await saveSyncData({ ...synced, channels: synced.channels, updatedAt: Date.now() });
    memoryCache.del('live:channels');
    pushLog('addChannel', `✅ Canal refrescado por proxy: ${ch.id} ${ch.expiresDate || ''}`);
    return result.url;
  } catch (error: any) {
    logger.error({ error: error.message, url: targetUrl.substring(0, 120) }, 'Fallo al refrescar canal expirado desde proxy');
    return null;
  }
}

export async function getChannelsHandler(request: FastifyRequest, reply: FastifyReply) {
  const { group, country, all, page = '1', limit } = request.query as any;
  const pageNum = parseInt(page) || 1;
  const showAll = all === 'true' || all === '1';
  const pageSize = limit ? (parseInt(limit) || PAGE_SIZE) : PAGE_SIZE;

  const syncedChannels = await loadChannels();

  let channels: LiveChannel[];
  if (syncedChannels && syncedChannels.length > 0) {
    channels = syncedChannels;
    if (group) {
      channels = channels.filter((ch) => ch.group === group);
    } else if (country) {
      channels = channels.filter((ch) => ch.country === country);
    }
  } else {
    if (group) {
      channels = await getChannelsByGroup(group);
    } else if (country) {
      channels = await getChannelsByCountry(country);
    } else {
      channels = await getCachedOrFetch(CACHE_KEY, () => fetchLiveChannels(), 900);
    }
  }

  if (!showAll) {
    channels = channels.filter((ch) => ch.online);
  }

  const total = channels.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const start = (pageNum - 1) * pageSize;
  const items = channels.slice(start, start + pageSize);

  return reply.send({
    page: pageNum,
    totalPages,
    total,
    items,
  });
}

export async function getChannelDetailHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as any;

  // Intentar obtener el canal desde los canales sincronizados primero
  const syncedChannels = await loadChannels();
  let channel: LiveChannel | undefined;

  if (syncedChannels && syncedChannels.length > 0) {
    channel = syncedChannels.find((ch) => ch.id === id);
  }

  // Si no se encuentra en los datos sincronizados, buscar en el proveedor (caché)
  if (!channel) {
    const channels = await getCachedOrFetch(CACHE_KEY, () => fetchLiveChannels(), 900);
    channel = channels.find((ch) => ch.id === id);
  }

  if (!channel) {
    return reply.status(404).send({ error: 'Channel not found' });
  }

  if (!channel.online) {
    return reply.status(503).send({ error: 'Channel is currently offline', id });
  }

  return reply.send(channel);
}

export async function getGroupsHandler(_request: FastifyRequest, reply: FastifyReply) {
  const groups = getChannelGroups();
  return reply.send({ groups });
}

export async function getCountriesHandler(_request: FastifyRequest, reply: FastifyReply) {
  const channels = await getCachedOrFetch(CACHE_KEY, () => fetchLiveChannels(), 900);
  const countries = [...new Set(channels.filter((ch) => ch.online).map((ch) => ch.country).filter(Boolean))].sort();
  return reply.send({ countries });
}

export async function getValidationStatusHandler(_request: FastifyRequest, reply: FastifyReply) {
  const channels = memoryCache.get<LiveChannel[]>(CACHE_KEY);
  if (!channels) {
    return reply.send({ status: 'pending', message: 'Validando canales...' });
  }
  return reply.send({
    status: 'completed',
    total: channels.length,
    online: channels.filter((ch) => ch.online).length,
  });
}

export async function getChatytvChannelHandler(request: FastifyRequest, reply: FastifyReply) {
  const { channel } = request.params as any;
  const { title, logo, country } = request.body as any;

  if (!channel || typeof channel !== 'string') {
    return reply.status(400).send({ error: 'Channel parameter is required' });
  }

  try {
    const result = await getChannelStream('chatytv', channel, undefined, 'addChannel');
    if (!result) {
      pushLog('addChannel', `❌ No se pudo agregar: ${channel} (sin stream)`);
      return reply.status(404).send({ error: 'Channel not found or unavailable' });
    }

    const channelData: LiveChannel = {
      ...result,
      title: title || result.title,
      logo: logo || result.logo,
      country: country || result.country,
    };
    applyExpiration(channelData);

    // Agregar a la lista de canales sincronizados
    const existing = await loadSyncData();
    const channels = existing?.channels || [];

    // Buscar si ya existe
    const existingIndex = channels.findIndex((ch) => ch.id === channelData.id);
    if (existingIndex !== -1) {
      // Mover al inicio
      channels.splice(existingIndex, 1);
    }
    // Agregar al inicio
    channels.unshift(channelData);

    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels,
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });

    memoryCache.del('live:channels');
    pushLog('addChannel', `✅ Canal agregado: ${channelData.id}`);
    return reply.send({ ok: true, channel: channelData, message: 'Channel added at the beginning of the list' });
  } catch (error) {
    pushLog('addChannel', '❌ Error al agregar canal');
    return reply.status(500).send({ error: 'Failed to add channel' });
  }
}

function extractRefreshSource(refreshUrl?: string): 'wsdeportes' | 'tvporinternet2' | 'cablevisionhd' | 'chatytv' | 'senalcolombia' | null {
  if (!refreshUrl) return null;
  if (refreshUrl.includes('wsdeportes.net')) return 'wsdeportes';
  if (refreshUrl.includes('tvporinternet2.com')) return 'tvporinternet2';
  if (refreshUrl.includes('cablevisionhd.com')) return 'cablevisionhd';
  if (refreshUrl.includes('chatytvgratis.net')) return 'chatytv';
  if (refreshUrl.includes('senalcolombia.tv')) return 'senalcolombia';
  return null;
}

async function manualExtractStream(
  fetchUrl: string,
  logPrefix: string,
): Promise<string | null> {
  let pageUrl: string = fetchUrl;
  let lastIframeUrl: string = '';
  let foundStream: string | null = null;
  let hostPageUrl: string | undefined;
  for (let depth = 0; depth < 4 && pageUrl && !foundStream; depth++) {
    pushLog(logPrefix, `  Nivel ${depth + 1}: ${pageUrl.substring(0, 150)}`);
    const html = depth === 0 ? await fetchHTML(pageUrl) : await fetchHTMLWithReferer(pageUrl, fetchUrl);

    // STREAM_URL en JS con \/ escapados (wsdeportes)
    const streamUrlVar = html.match(/STREAM_URL\s*=\s*["']((?:https?:\\\/\\\/|https:\/\/)[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
    if (streamUrlVar) {
      foundStream = streamUrlVar[1].replace(/\\\//g, '/');
      hostPageUrl = pageUrl;
      pushLog(logPrefix, `  ✅ STREAM_URL en JS`);
      break;
    }

    // Tambien buscar cualquier URL con \/ escapados
    const escapedM3u8 = html.match(/["']((?:https?:)?\\\/\\\/[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
    if (escapedM3u8) {
      foundStream = escapedM3u8[1].replace(/\\\//g, '/');
      if (!foundStream.startsWith('http')) foundStream = 'https:' + foundStream;
      hostPageUrl = pageUrl;
      pushLog(logPrefix, `  ✅ .m3u8 con slashes escapados`);
      break;
    }

    const m3u8 = html.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/i);
    if (m3u8) { foundStream = m3u8[0]; hostPageUrl = pageUrl; pushLog(logPrefix, `  ✅ .m3u8 nivel ${depth + 1}`); break; }
    const fileMatch = html.match(/file["']?\s*:\s*["']([^"']+)["']/i);
    const srcMatch = html.match(/src["']?\s*:\s*["']([^"']+(?:m3u8|ts|mp4)[^"']*)["']/i);
    const sourceTag = html.match(/<source\s[^>]*src=["']([^"']+)["']/i);
    if (fileMatch) { foundStream = fileMatch[1]; hostPageUrl = pageUrl; break; }
    if (srcMatch) { foundStream = srcMatch[1]; hostPageUrl = pageUrl; break; }
    if (sourceTag) { foundStream = sourceTag[1]; hostPageUrl = pageUrl; break; }

    // Buscar iframe con src O data-src
    const iframeSrc = html.match(/<iframe[^>]+(?:name|id)="?player"?[^>]+(?:data-src|src)=["']([^"']+)["']/i)?.[1] ||
                      html.match(/<iframe[^>]+(?:data-src|src)=["']([^"']+(?:player|core|stream|embed|tv))[^"']*["']/i)?.[1] ||
                      html.match(/<iframe[^>]+data-src=["']([^"']+)["']/i)?.[1] ||
                      html.match(/<embed[^>]+src=["']([^"']+)["']/i)?.[1] ||
                      html.match(/<video[^>]+src=["']([^"']+)["']/i)?.[1];
    if (iframeSrc) {
      const cleaned = iframeSrc.replace(/&amp;/g, '&');
      lastIframeUrl = cleaned.startsWith('http') ? cleaned : new URL(cleaned, pageUrl).href;
      pageUrl = lastIframeUrl;
    } else {
      pushLog(logPrefix, `  No más iframes player en este nivel`);
      // Buscar cualquier .m3u8 en scripts o data (con o sin escape)
      const scriptM3u8 = html.match(/["'](https?:\/\/[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
      const scriptM3u8Escaped = html.match(/["'](https?:\\\/\\\/[^"']+\.(?:m3u8|m3u)[^"']*?)["']/i);
      if (scriptM3u8) {
        pushLog(logPrefix, `  ✅ .m3u8 en script/data`);
        foundStream = scriptM3u8[1];
        hostPageUrl = pageUrl;
        break;
      }
      if (scriptM3u8Escaped) {
        foundStream = scriptM3u8Escaped[1].replace(/\\\//g, '/');
        hostPageUrl = pageUrl;
        pushLog(logPrefix, `  ✅ .m3u8 con slashes escapados en script`);
        break;
      }
      pushLog(logPrefix, `  HTML (primeros 400): ${html.substring(0, 400)}`);
      pageUrl = '';
    }
  }
  if (!foundStream && lastIframeUrl) {
    pushLog(logPrefix, `  ⚠ Usando URL del último iframe como stream`);
    foundStream = lastIframeUrl;
  }
  if (foundStream) {
    pushLog(logPrefix, `  Verificando URL: ${foundStream.substring(0, 120)}...`);
    let streamOk = false;
    try {
      const res = await httpClient.head(foundStream, { timeout: 10000 });
      streamOk = res.status === 200;
      pushLog(logPrefix, `  HEAD: ${res.status}`);
    } catch (e: any) {
      pushLog(logPrefix, `  HEAD falló: ${(e.response?.status || e.code || e.message || '').toString().substring(0, 60)}`);
    }
    // Si el stream da 403/404, usar la URL del nivel que lo aloja (si da 200)
    if (!streamOk && hostPageUrl && hostPageUrl.startsWith('http')) {
      pushLog(logPrefix, `  Intentando URL del nivel anterior (nivel 3): ${hostPageUrl.substring(0, 120)}...`);
      try {
        const res = await httpClient.get(hostPageUrl, { timeout: 10000, headers: { Referer: fetchUrl } });
        if (res.status === 200) {
          pushLog(logPrefix, `  ✅ Usando URL del nivel anterior: ${hostPageUrl.substring(0, 120)}`);
          foundStream = hostPageUrl;
        } else {
          pushLog(logPrefix, `  ⚠ Nivel anterior no da 200 (${res.status}), manteniendo URL original`);
        }
      } catch (e: any) {
        pushLog(logPrefix, `  ⚠ No se pudo verificar nivel anterior: ${(e.message || '').substring(0, 60)}`);
      }
    }
  }
  return foundStream;
}

function extractSlugFromUrl(refreshUrl?: string, proveedor?: string): string | null {
  if (!refreshUrl) return null;
  try {
    const urlObj = new URL(refreshUrl);

    if (proveedor === 'wsdeportes') {
      // La refreshUrl es https://wsdeportes.net/?v=winsportsmas&op=2
      // Necesitamos reconstruir el parámetro original "winsportsmas&op=2"
      const v = urlObj.searchParams.get('v');
      if (!v) return null;
      const remaining: string[] = [];
      urlObj.searchParams.forEach((val, key) => {
        if (key !== 'v') remaining.push(`${key}=${val}`);
      });
      return remaining.length > 0 ? `${v}&${remaining.join('&')}` : v;
    }

    // Para cablevisionhd, tvporinternet2 y chatytv, el slug está en el path
    const pathname = urlObj.pathname.replace(/^\//, '').replace(/\/+$/, '');
    const slug = pathname.replace(/\.\w+$/, ''); // remove .html or .php
    return slug || null;
  } catch {
    return null;
  }
}

export async function refreshExpiredChannelsHandler(_request: FastifyRequest, reply: FastifyReply) {
  const synced = await loadSyncData();
  if (!synced || !Array.isArray(synced.channels)) {
    return reply.status(400).send({ error: 'No sync data found' });
  }

  if (!startSync('refreshExpired')) {
    return reply.send({ ok: true, message: 'Refresh expired already in progress' });
  }

  clearLogs('refreshExpired');
  pushLog('refreshExpired', '=== Iniciando refresh de canales expirados ===');
  reply.send({ ok: true, message: 'Refresh expired channels started' });

  const channels = synced.channels;
  const expiredChannels = channels.filter(ch => ch.url?.includes('expires=') && ch.refreshUrl);
  const totalToProcess = expiredChannels.length;
  pushLog('refreshExpired', `Canales totales en BD: ${channels.length}`);
  pushLog('refreshExpired', `Canales con URL expirada y refreshUrl: ${totalToProcess}`);

  const updatedChannels: LiveChannel[] = [];
  const failedChannels: { id: string; title: string; error: string }[] = [];
  let processed = 0;

  for (const ch of channels) {
    if (!ch.url || !ch.url.includes('expires=') || !ch.refreshUrl) {
      continue;
    }

    pushLog('refreshExpired', `→ [${processed + 1}/${totalToProcess}] Procesando: ${ch.title || ch.id}`);

    const source = extractRefreshSource(ch.refreshUrl);
    if (!source) {
      pushLog('refreshExpired', `  ❌ Fuente no detectada en refreshUrl: ${ch.refreshUrl}`);
      failedChannels.push({ id: ch.id, title: ch.title || ch.id, error: 'Fuente no detectada' });
      processed++;
      updateSyncProgress('refreshExpired', processed, `[${processed}/${totalToProcess}] ${ch.title || ch.id} — fuente no detectada`, totalToProcess);
      continue;
    }
    pushLog('refreshExpired', `  Proveedor: ${source}`);

    const slug = extractSlugFromUrl(ch.refreshUrl, source);
    if (!slug) {
      pushLog('refreshExpired', `  ❌ No se pudo extraer slug de: ${ch.refreshUrl}`);
      failedChannels.push({ id: ch.id, title: ch.title || ch.id, error: 'slug inválido' });
      processed++;
      updateSyncProgress('refreshExpired', processed, `[${processed}/${totalToProcess}] ${ch.title || ch.id} — slug inválido`, totalToProcess);
      continue;
    }
    pushLog('refreshExpired', `  Slug extraído: ${slug}`);
    const fetchUrl = source === 'wsdeportes' ? `https://wsdeportes.net/?v=${slug}` :
      source === 'tvporinternet2' ? `https://www.tvporinternet2.com/${slug}.php` :
      source === 'cablevisionhd' ? `https://www.cablevisionhd.com/${slug}.php` :
      source === 'chatytv' ? `https://www.chatytvgratis.net/${slug}/` :
      source === 'senalcolombia' ? `https://www.senalcolombia.tv/${slug}` :
      `https://${source}.com/${slug}`;
    pushLog('refreshExpired', `  URL consultada: ${fetchUrl}`);

    pushLog('refreshExpired', `  Invalidando caché para ${source}:${slug}...`);
    memoryCache.del(`${source}:${slug}`);
    memoryCache.del(`${source}:${slug}:default`);
    if (ch.refreshOption) memoryCache.del(`${source}:${slug}:${ch.refreshOption}`);

    pushLog('refreshExpired', `  Consultando a ${source}...`);
    try {
      const result = await getChannelStream(source, slug, ch.refreshOption || undefined);
      if (result && result.url) {
        pushLog('refreshExpired', `  ✅ URL obtenida: ${result.url.substring(0, 120)}...`);
        ch.url = result.url;
        applyExpiration(ch);
        updatedChannels.push(ch);
      } else {
        pushLog('refreshExpired', `  ❌ El proveedor no devolvió URL`);
        pushLog('refreshExpired', `  🔍 Extrayendo manualmente desde ${fetchUrl}...`);
        try {
          const foundStream = await manualExtractStream(fetchUrl, 'refreshExpired');
          if (foundStream) {
            pushLog('refreshExpired', `  ✅ Stream: ${foundStream.substring(0, 120)}`);
            ch.url = foundStream;
            applyExpiration(ch);
            updatedChannels.push(ch);
            processed++;
            updateSyncProgress('refreshExpired', processed, `[${processed}/${totalToProcess}] ✅ ${ch.title || ch.id}`, totalToProcess);
            continue;
          }
          pushLog('refreshExpired', `  ❌ No se encontró stream en la cadena de iframes`);
        } catch (diagErr: any) {
          pushLog('refreshExpired', `  Error extracción manual: ${diagErr.message}`);
        }
        failedChannels.push({ id: ch.id, title: ch.title || ch.id, error: 'No se obtuvo URL del proveedor' });
        processed++;
        updateSyncProgress('refreshExpired', processed, `[${processed}/${totalToProcess}] ❌ ${ch.title || ch.id} — sin URL`, totalToProcess);
        continue;
      }
    } catch (error: any) {
      pushLog('refreshExpired', `  ❌ Error: ${error.message}`);
      failedChannels.push({ id: ch.id, title: ch.title || ch.id, error: error.message });
      processed++;
      updateSyncProgress('refreshExpired', processed, `[${processed}/${totalToProcess}] ❌ ${ch.title || ch.id} — ${error.message}`, totalToProcess);
      continue;
    }
    processed++;
    updateSyncProgress('refreshExpired', processed, `[${processed}/${totalToProcess}] ✅ ${ch.title || ch.id}`, totalToProcess);
  }

  if (updatedChannels.length > 0) {
    pushLog('refreshExpired', `Guardando ${updatedChannels.length} canales actualizados en Firestore...`);
    await saveSyncData({ ...synced, channels, updatedAt: Date.now() });
    memoryCache.del('live:channels');
    pushLog('refreshExpired', '✅ Guardado exitoso');
  }

  const count = updatedChannels.length;
  if (failedChannels.length > 0) {
    const errorGroups: Record<string, number> = {};
    for (const f of failedChannels) {
      errorGroups[f.error] = (errorGroups[f.error] || 0) + 1;
    }
    const summary = Object.entries(errorGroups)
      .sort((a, b) => b[1] - a[1])
      .map(([msg, n]) => `"${msg}" (${n})`)
      .join(', ');
    pushLog('refreshExpired', `⛔ Finalizado con errores: ${count} actualizados, ${failedChannels.length} fallos`);
    pushLog('refreshExpired', `❌ Canales fallidos (usar id para corregir):`);
    for (const f of failedChannels) {
      pushLog('refreshExpired', `  - [${f.id}] ${f.title || f.id}: ${f.error}`);
    }
    failSync('refreshExpired', `${count} actualizados, ${failedChannels.length} fallos: ${summary}`);
  } else {
    completeSync('refreshExpired', count);
  }
}

/**
 * Actualiza la URL de los canales que tengan refreshUrl, usando el proveedor
 * especificado en el campo "proveedor" del objeto del canal.
 * Lee los canales desde Firestore y actualiza solo la url.
 */
export async function refreshAllChannelsHandler(_request: FastifyRequest, reply: FastifyReply) {
  const synced = await loadSyncData();
  if (!synced || !Array.isArray(synced.channels)) {
    return reply.status(400).send({ error: 'No sync data found' });
  }

  if (!startSync('refreshAll')) {
    return reply.send({ ok: true, message: 'Refresh all already in progress' });
  }

  clearLogs('refreshAll');
  pushLog('refreshAll', '=== Iniciando refresh de TODOS los canales ===');
  reply.send({ ok: true, message: 'Refresh all channels started' });

  const channels = synced.channels;
  const totalToProcess = channels.filter(ch => ch.refreshUrl).length;
  pushLog('refreshAll', `Canales totales en BD: ${channels.length}`);
  pushLog('refreshAll', `Canales con refreshUrl: ${totalToProcess}`);

  const updatedChannels: LiveChannel[] = [];
  const failedChannels: { id: string; title: string; error: string }[] = [];
  let processed = 0;

  for (const ch of channels) {
    if (!ch.refreshUrl) {
      continue;
    }

    pushLog('refreshAll', `→ [${processed + 1}/${totalToProcess}] Procesando: ${ch.title || ch.id}`);
    pushLog('refreshAll', `  refreshUrl: ${ch.refreshUrl}`);

    const provedor = (ch.proveedor || extractRefreshSource(ch.refreshUrl)) as string;
    if (provedor !== 'wsdeportes' && provedor !== 'cablevisionhd' && provedor !== 'tvporinternet2' && provedor !== 'chatytv' && provedor !== 'senalcolombia') {
      pushLog('refreshAll', `  ❌ Proveedor no soportado: ${provedor || '(none)'}`);
      failedChannels.push({ id: ch.id, title: ch.title || ch.id, error: `Proveedor no soportado: ${provedor || '(none)'}` });
      processed++;
      updateSyncProgress('refreshAll', processed, `[${processed}/${totalToProcess}] ${ch.title || ch.id} — proveedor no soportado`, totalToProcess);
      continue;
    }
    const source: 'wsdeportes' | 'cablevisionhd' | 'tvporinternet2' | 'chatytv' | 'senalcolombia' = provedor;
    pushLog('refreshAll', `  Proveedor: ${source}`);

    const slug = extractSlugFromUrl(ch.refreshUrl, source);
    if (!slug) {
      pushLog('refreshAll', `  ❌ No se pudo extraer slug de refreshUrl`);
      failedChannels.push({ id: ch.id, title: ch.title || ch.id, error: 'No se pudo extraer slug de refreshUrl' });
      processed++;
      updateSyncProgress('refreshAll', processed, `[${processed}/${totalToProcess}] ${ch.title || ch.id} — slug inválido`, totalToProcess);
      continue;
    }
    pushLog('refreshAll', `  Slug: ${slug}${ch.refreshOption ? ` | Opción: ${ch.refreshOption}` : ''}`);
    const fetchUrl = source === 'wsdeportes' ? `https://wsdeportes.net/?v=${slug}` :
      source === 'tvporinternet2' ? `https://www.tvporinternet2.com/${slug}.php` :
      source === 'cablevisionhd' ? `https://www.cablevisionhd.com/${slug}.php` :
      source === 'chatytv' ? `https://www.chatytvgratis.net/${slug}/` :
      source === 'senalcolombia' ? `https://www.senalcolombia.tv/${slug}` :
      `https://${source}.com/${slug}`;
    pushLog('refreshAll', `  URL consultada: ${fetchUrl}`);

    pushLog('refreshAll', `  Invalidando caché...`);
    memoryCache.del(`${source}:${slug}`);
    memoryCache.del(`${source}:${slug}:default`);
    if (ch.refreshOption) memoryCache.del(`${source}:${slug}:${ch.refreshOption}`);

    pushLog('refreshAll', `  Consultando a ${source}...`);
    try {
      const result = await getChannelStream(source, slug, ch.refreshOption || undefined);
      if (result && result.url) {
        pushLog('refreshAll', `  ✅ URL obtenida: ${result.url.substring(0, 120)}...`);
        ch.url = result.url;
        applyExpiration(ch);
        if (!ch.proveedor) ch.proveedor = source;
        updatedChannels.push(ch);
      } else {
        pushLog('refreshAll', `  ❌ El proveedor no devolvió URL`);
        pushLog('refreshAll', `  🔍 Extrayendo manualmente desde ${fetchUrl}...`);
        try {
          const foundStream = await manualExtractStream(fetchUrl, 'refreshAll');
          if (foundStream) {
            pushLog('refreshAll', `  ✅ Stream: ${foundStream.substring(0, 120)}`);
            ch.url = foundStream;
            applyExpiration(ch);
            if (!ch.proveedor) ch.proveedor = source;
            updatedChannels.push(ch);
            processed++;
            updateSyncProgress('refreshAll', processed, `[${processed}/${totalToProcess}] ✅ ${ch.title || ch.id}`, totalToProcess);
            continue;
          }
          pushLog('refreshAll', `  ❌ No se encontró stream en la cadena de iframes`);
        } catch (diagErr: any) {
          pushLog('refreshAll', `  Error extracción manual: ${diagErr.message}`);
        }
        failedChannels.push({ id: ch.id, title: ch.title || ch.id, error: 'No se obtuvo URL del proveedor' });
        processed++;
        updateSyncProgress('refreshAll', processed, `[${processed}/${totalToProcess}] ❌ ${ch.title || ch.id} — sin URL`, totalToProcess);
        continue;
      }
    } catch (error: any) {
      pushLog('refreshAll', `  ❌ Error: ${error.message}`);
      failedChannels.push({ id: ch.id, title: ch.title || ch.id, error: error.message });
      processed++;
      updateSyncProgress('refreshAll', processed, `[${processed}/${totalToProcess}] ❌ ${ch.title || ch.id} — ${error.message}`, totalToProcess);
      continue;
    }
    processed++;
    updateSyncProgress('refreshAll', processed, `[${processed}/${totalToProcess}] ✅ ${ch.title || ch.id}`, totalToProcess);
  }

  if (updatedChannels.length > 0) {
    pushLog('refreshAll', `Guardando ${updatedChannels.length} canales actualizados en Firestore...`);
    await saveSyncData({ ...synced, channels, updatedAt: Date.now() });
    memoryCache.del('live:channels');
    pushLog('refreshAll', '✅ Guardado exitoso');
  }

  const count = updatedChannels.length;
  if (failedChannels.length > 0) {
    const errorGroups: Record<string, number> = {};
    for (const f of failedChannels) {
      errorGroups[f.error] = (errorGroups[f.error] || 0) + 1;
    }
    const summary = Object.entries(errorGroups)
      .sort((a, b) => b[1] - a[1])
      .map(([msg, n]) => `"${msg}" (${n})`)
      .join(', ');
    pushLog('refreshAll', `⛔ Finalizado con errores: ${count} actualizados, ${failedChannels.length} fallos`);
    pushLog('refreshAll', `❌ Canales fallidos (usar id para corregir):`);
    for (const f of failedChannels) {
      pushLog('refreshAll', `  - [${f.id}] ${f.title || f.id}: ${f.error}`);
    }
    failSync('refreshAll', `${count} actualizados, ${failedChannels.length} fallos: ${summary}`);
  } else {
    pushLog('refreshAll', `✅ Completado: ${count} canales actualizados`);
    completeSync('refreshAll', count);
  }
}

export async function getTvPorInternet2Handler(request: FastifyRequest, reply: FastifyReply) {
  const { slug } = request.params as any;
  const { title, logo, country, option } = request.body as any;

  if (!slug || typeof slug !== 'string') {
    return reply.status(400).send({ error: 'Slug parameter is required (e.g., caracol-en-vivo-por-internet)' });
  }

  if (!title || typeof title !== 'string') {
    return reply.status(400).send({ error: 'title is required in body' });
  }

  try {
    const result = await getChannelStream('tvporinternet2', slug, option || undefined, 'addChannel');
    if (!result || !result.url) {
      return reply.status(404).send({ error: 'Channel not found or unavailable' });
    }

    // Construir el canal con los datos personalizados del body
    const channelData: LiveChannel = {
      id: `live_${slug}`,
      title: title,
      logo: logo || undefined,
      group: 'Canales TV',
      country: country || undefined,
      url: result.url,
      type: 'live',
      online: true,
      refreshUrl: result.refreshUrl,
      refreshOption: option || undefined,
      proveedor: 'tvporinternet2',
    };
    applyExpiration(channelData);

    // Agregar a la lista de canales sincronizados
    const existing = await loadSyncData();
    const channels = existing?.channels || [];

    // Buscar si ya existe
    const existingIndex = channels.findIndex((ch) => ch.id === channelData.id);
    if (existingIndex !== -1) {
      // Mover al inicio
      channels.splice(existingIndex, 1);
    }
    // Agregar al inicio
    channels.unshift(channelData);

    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels,
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });

    memoryCache.del('live:channels');
    pushLog('addChannel', `✅ Canal agregado: ${channelData.id}`);
    return reply.send({ ok: true, channel: channelData, message: 'Channel added at the beginning of the list' });
  } catch (error) {
    pushLog('addChannel', '❌ Error al agregar canal');
    return reply.status(500).send({ error: 'Failed to add channel' });
  }
}

export async function getCablevisionHdHandler(request: FastifyRequest, reply: FastifyReply) {
  const { slug } = request.params as any;
  const { title, logo, country, option } = request.body as any;

  if (!slug || typeof slug !== 'string') {
    return reply.status(400).send({ error: 'Slug parameter is required (e.g., fox-sports-en-vivo)' });
  }

  if (!title || typeof title !== 'string') {
    return reply.status(400).send({ error: 'title is required in body' });
  }

  try {
    const result = await getChannelStream('cablevisionhd', slug, option || undefined, 'addChannel');
    if (!result || !result.url) {
      return reply.status(404).send({ error: 'Channel not found or unavailable' });
    }

    // Construir el canal con los datos personalizados del body
    const channelData: LiveChannel = {
      id: `live_${slug}`,
      title: title,
      logo: logo || undefined,
      group: 'Canales TV',
      country: country || undefined,
      url: result.url,
      type: 'live',
      online: true,
      refreshUrl: result.refreshUrl,
      refreshOption: option || undefined,
      proveedor: 'cablevisionhd',
    };
    applyExpiration(channelData);

    // Agregar a la lista de canales sincronizados
    const existing = await loadSyncData();
    const channels = existing?.channels || [];

    // Buscar si ya existe
    const existingIndex = channels.findIndex((ch) => ch.id === channelData.id);
    if (existingIndex !== -1) {
      // Mover al inicio
      channels.splice(existingIndex, 1);
    }
    // Agregar al inicio
    channels.unshift(channelData);

    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels,
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });

    memoryCache.del('live:channels');
    pushLog('addChannel', `✅ Canal agregado: ${channelData.id}`);
    return reply.send({ ok: true, channel: channelData, message: 'Channel added at the beginning of the list' });
  } catch (error) {
    pushLog('addChannel', '❌ Error al agregar canal');
    return reply.status(500).send({ error: 'Failed to add channel' });
  }
}

export async function getWsDeportesChannelHandler(request: FastifyRequest, reply: FastifyReply) {
  const { parameter } = request.params as any;
  const { title, logo, country } = request.body as any;

  if (!parameter || typeof parameter !== 'string') {
    return reply.status(400).send({ error: 'Parameter is required (winsports, winsportsmas, etc.)' });
  }

  if (!title || typeof title !== 'string') {
    return reply.status(400).send({ error: 'title is required in body' });
  }

  try {
    const result = await getChannelStream('wsdeportes', parameter, undefined, 'addChannel');
    if (!result || !result.url) {
      return reply.status(404).send({ error: 'Channel not found or unavailable' });
    }

    // Construir el canal con los datos personalizados del body
    const channelData: LiveChannel = {
      id: result.id,
      title: title,
      logo: logo || undefined,
      group: 'Canales Deportivos',
      country: country || undefined,
      url: result.url,
      type: 'live',
      online: true,
      refreshUrl: result.refreshUrl,
      proveedor: 'wsdeportes',
    };
    applyExpiration(channelData);

    // Agregar a la lista de canales sincronizados
    const existing = await loadSyncData();
    const channels = existing?.channels || [];


    // Buscar si ya existe
    const existingIndex = channels.findIndex((ch) => ch.id === channelData.id);
    if (existingIndex !== -1) {
      // Mover al inicio
      channels.splice(existingIndex, 1);
    }
    // Agregar al inicio
    channels.unshift(channelData);

    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels,
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });

    memoryCache.del('live:channels');
    pushLog('addChannel', `✅ Canal agregado: ${channelData.id}`);
    return reply.send({ ok: true, channel: channelData, message: 'Channel added at the beginning of the list' });
  } catch (error) {
    pushLog('addChannel', '❌ Error al agregar canal');
    return reply.status(500).send({ error: 'Failed to add channel' });
  }
}

export async function getSenalColombiaChannelHandler(request: FastifyRequest, reply: FastifyReply) {
  const { slug } = request.params as any;
  const { title, logo, country } = request.body as any;

  if (!slug || typeof slug !== 'string') {
    return reply.status(400).send({ error: 'Slug parameter is required (e.g., senal-en-vivo)' });
  }

  if (!title || typeof title !== 'string') {
    return reply.status(400).send({ error: 'title is required in body' });
  }

  try {
    const result = await getChannelStream('senalcolombia', slug, undefined, 'addChannel');
    if (!result || !result.url) {
      return reply.status(404).send({ error: 'Channel not found or unavailable' });
    }

    const channelData: LiveChannel = {
      id: `live_${slug}`,
      title: title,
      logo: logo || undefined,
      group: 'Canales TV',
      country: country || undefined,
      url: result.url,
      type: 'live',
      online: true,
      refreshUrl: result.refreshUrl,
      proveedor: 'senalcolombia',
    };
    applyExpiration(channelData);

    const existing = await loadSyncData();
    const channels = existing?.channels || [];

    const existingIndex = channels.findIndex((ch) => ch.id === channelData.id);
    if (existingIndex !== -1) {
      channels.splice(existingIndex, 1);
    }
    channels.unshift(channelData);

    await saveSyncData({
      movies: existing?.movies || [],
      series: existing?.series || [],
      channels,
      popularMovies: existing?.popularMovies || [],
      popularSeries: existing?.popularSeries || [],
      estrenoMovies: existing?.estrenoMovies || [],
      estrenoSeries: existing?.estrenoSeries || [],
      updatedAt: Date.now(),
    });

    memoryCache.del('live:channels');
    pushLog('addChannel', `✅ Canal agregado: ${channelData.id}`);
    return reply.send({ ok: true, channel: channelData, message: 'Channel added at the beginning of the list' });
  } catch (error) {
    pushLog('addChannel', '❌ Error al agregar canal');
    return reply.status(500).send({ error: 'Failed to add channel' });
  }
}

const UPDATABLE_CHANNEL_FIELDS = [
  'country', 'group', 'logo', 'online', 'proveedor', 'refreshUrl', 'refreshOption', 'title', 'type', 'url',
] as const;

export async function updateChannelHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as any;
  const body = (request.body || {}) as Record<string, unknown>;

  if (!id || typeof id !== 'string') {
    return reply.status(400).send({ error: 'Channel id is required' });
  }

  const updates: Partial<LiveChannel> = {};
  for (const field of UPDATABLE_CHANNEL_FIELDS) {
    if (body[field] !== undefined) {
      (updates as any)[field] = body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return reply.status(400).send({
      error: 'No updatable fields provided',
      allowedFields: UPDATABLE_CHANNEL_FIELDS,
    });
  }

  try {
    const synced = await loadSyncData();
    if (!synced || !Array.isArray(synced.channels)) {
      return reply.status(404).send({ error: 'No sync data found' });
    }

    const channels = synced.channels;
    const index = channels.findIndex((ch) => ch.id === id);
    if (index === -1) {
      return reply.status(404).send({ error: 'Channel not found', id });
    }

    const updatedChannel: LiveChannel = {
      ...channels[index],
      ...updates,
      id,
      type: (updates.type as any) || channels[index].type || 'live',
      online: updates.online !== undefined ? Boolean(updates.online) : channels[index].online,
    };

    channels[index] = updatedChannel;

    await saveSyncData({
      movies: synced.movies || [],
      series: synced.series || [],
      channels,
      popularMovies: synced.popularMovies || [],
      popularSeries: synced.popularSeries || [],
      estrenoMovies: synced.estrenoMovies || [],
      estrenoSeries: synced.estrenoSeries || [],
      updatedAt: Date.now(),
    });

    memoryCache.del('live:channels');
    return reply.send({ ok: true, channel: updatedChannel, message: 'Channel updated' });
  } catch (error: any) {
    logger.error({ error: error.message, id }, 'Failed to update channel');
    return reply.status(500).send({ error: 'Failed to update channel' });
  }
}

const REFRESH_ONE_TYPE = 'refreshOne';

export async function refreshChannelHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = (request.body || {}) as any;
  const id = body?.id || (request.params as any)?.id;

  if (!id || typeof id !== 'string') {
    return reply.status(400).send({ error: 'Channel id is required (body: { id })' });
  }

  if (!startSync(REFRESH_ONE_TYPE)) {
    return reply.send({ ok: true, message: 'Refresh channel already in progress' });
  }

  clearLogs(REFRESH_ONE_TYPE);
  pushLog(REFRESH_ONE_TYPE, '=== Refrescando canal: ' + id + ' ===');
  reply.send({ ok: true, message: 'Refresh channel started', id });

  try {
    const synced = await loadSyncData();
    if (!synced || !Array.isArray(synced.channels)) {
      pushLog(REFRESH_ONE_TYPE, 'No hay datos sincronizados');
      failSync(REFRESH_ONE_TYPE, 'No hay datos sincronizados');
      return;
    }

    const channels = synced.channels;
    const index = channels.findIndex((ch) => ch.id === id);
    if (index === -1) {
      pushLog(REFRESH_ONE_TYPE, 'Canal no encontrado: ' + id);
      failSync(REFRESH_ONE_TYPE, 'Canal no encontrado: ' + id);
      return;
    }

    const ch = channels[index];
    const source = (ch.proveedor as any) || extractRefreshSource(ch.refreshUrl);
    if (!source || (source !== 'wsdeportes' && source !== 'cablevisionhd' && source !== 'tvporinternet2' && source !== 'chatytv' && source !== 'senalcolombia')) {
      pushLog(REFRESH_ONE_TYPE, 'Proveedor no soportado: ' + (source || '(none)'));
      failSync(REFRESH_ONE_TYPE, 'Proveedor no soportado: ' + (source || '(none)'));
      return;
    }
    pushLog(REFRESH_ONE_TYPE, 'Proveedor: ' + source);

    const slug = extractSlugFromUrl(ch.refreshUrl, source);
    if (!slug) {
      pushLog(REFRESH_ONE_TYPE, 'No se pudo extraer slug de refreshUrl: ' + ch.refreshUrl);
      failSync(REFRESH_ONE_TYPE, 'Slug invalido en refreshUrl: ' + ch.refreshUrl);
      return;
    }
    pushLog(REFRESH_ONE_TYPE, 'Slug: ' + slug + (ch.refreshOption ? ' | Opcion: ' + ch.refreshOption : ''));

    const fetchUrl = source === 'wsdeportes' ? 'https://wsdeportes.net/?v=' + slug :
      source === 'tvporinternet2' ? 'https://www.tvporinternet2.com/' + slug + '.php' :
      source === 'cablevisionhd' ? 'https://www.cablevisionhd.com/' + slug + '.php' :
      source === 'chatytv' ? 'https://www.chatytvgratis.net/' + slug + '/' :
      source === 'senalcolombia' ? 'https://www.senalcolombia.tv/' + slug :
      'https://' + source + '.com/' + slug;
    pushLog(REFRESH_ONE_TYPE, 'URL consultada: ' + fetchUrl);

    pushLog(REFRESH_ONE_TYPE, 'Invalidando cache...');
    memoryCache.del(source + ':' + slug);
    memoryCache.del(source + ':' + slug + ':default');
    if (ch.refreshOption) memoryCache.del(source + ':' + slug + ':' + ch.refreshOption);

    pushLog(REFRESH_ONE_TYPE, 'Consultando a ' + source + '...');
    let newUrl: string | null = null;
    try {
      const result = await getChannelStream(source as any, slug, ch.refreshOption || undefined);
      if (result && result.url) {
        newUrl = result.url;
        pushLog(REFRESH_ONE_TYPE, 'URL obtenida: ' + result.url.substring(0, 120) + '...');
      } else {
        pushLog(REFRESH_ONE_TYPE, 'El proveedor no devolvio URL');
        pushLog(REFRESH_ONE_TYPE, 'Extrayendo manualmente desde ' + fetchUrl + '...');
        const foundStream = await manualExtractStream(fetchUrl, REFRESH_ONE_TYPE);
        if (foundStream) {
          newUrl = foundStream;
          pushLog(REFRESH_ONE_TYPE, 'Stream manual: ' + foundStream.substring(0, 120));
        } else {
          pushLog(REFRESH_ONE_TYPE, 'No se encontro stream en la cadena de iframes');
        }
      }
    } catch (error: any) {
      pushLog(REFRESH_ONE_TYPE, 'Error: ' + error.message);
    }

    if (!newUrl) {
      pushLog(REFRESH_ONE_TYPE, 'No se pudo obtener URL para ' + id);
      failSync(REFRESH_ONE_TYPE, 'No se pudo obtener URL para ' + id);
      return;
    }

    channels[index] = { ...ch, url: newUrl, online: true };
    applyExpiration(channels[index]);
    await saveSyncData({
      movies: synced.movies || [],
      series: synced.series || [],
      channels,
      popularMovies: synced.popularMovies || [],
      popularSeries: synced.popularSeries || [],
      estrenoMovies: synced.estrenoMovies || [],
      estrenoSeries: synced.estrenoSeries || [],
      updatedAt: Date.now(),
    });
    memoryCache.del('live:channels');
    pushLog(REFRESH_ONE_TYPE, 'Canal actualizado: ' + id);
    completeSync(REFRESH_ONE_TYPE, 1);
  } catch (error: any) {
    pushLog(REFRESH_ONE_TYPE, 'Error general: ' + error.message);
    failSync(REFRESH_ONE_TYPE, error.message);
  }
}
