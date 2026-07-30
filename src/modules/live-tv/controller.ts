import { FastifyRequest, FastifyReply } from 'fastify';
import { fetchLiveChannels, getChannelsByGroup, getChannelsByCountry, getChannelGroups } from '../../providers/live-tv';
import { getChannelStream } from '../../providers/custom-channels';
import { getCachedOrFetch, memoryCache } from '../../cache';
import { loadSyncData, saveSyncData } from '../../services/data-store';
import { LiveChannel } from '../../types';
import { logger } from '../../utils/logger';
import { startSync, completeSync, failSync, updateSyncProgress, pushLog, clearLogs } from '../../services/sync-status';
import { fetchHTML } from '../../utils/http';

const CACHE_KEY = 'live:channels';
const PAGE_SIZE = 10;

export async function getChannelsHandler(request: FastifyRequest, reply: FastifyReply) {
  const { group, country, all, page = '1' } = request.query as any;
  const pageNum = parseInt(page) || 1;
  const showAll = all === 'true' || all === '1';

  const synced = await loadSyncData();
  const syncedChannels = synced?.channels;

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
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  const start = (pageNum - 1) * PAGE_SIZE;
  const items = channels.slice(start, start + PAGE_SIZE);

  return reply.send({
    page: pageNum,
    totalPages,
    total,
    items,
  });
}

export async function getChannelDetailHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as any;

  // Intentar obtener el canal desde los datos sincronizados primero
  const synced = await loadSyncData();
  const syncedChannels = synced?.channels;
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

  if (!channel || typeof channel !== 'string') {
    return reply.status(400).send({ error: 'Channel parameter is required' });
  }

  try {
    const result = await getChannelStream('chatytv', channel);
    if (!result) {
      return reply.status(404).send({ error: 'Channel not found or unavailable' });
    }

    // Agregar a la lista de canales sincronizados
    const existing = await loadSyncData();
    const channels = existing?.channels || [];

    // Buscar si ya existe
    const existingIndex = channels.findIndex((ch) => ch.id === result.id);
    if (existingIndex !== -1) {
      // Mover al inicio
      channels.splice(existingIndex, 1);
    }
    // Agregar al inicio
    channels.unshift(result);

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
    return reply.send({ ok: true, channel: result, message: 'Channel added at the beginning of the list' });
  } catch (error) {
    return reply.status(500).send({ error: 'Failed to add channel' });
  }
}

function extractRefreshSource(refreshUrl?: string): 'wsdeportes' | 'tvporinternet2' | 'cablevisionhd' | null {
  if (!refreshUrl) return null;
  if (refreshUrl.includes('wsdeportes.net')) return 'wsdeportes';
  if (refreshUrl.includes('tvporinternet2.com')) return 'tvporinternet2';
  if (refreshUrl.includes('cablevisionhd.com')) return 'cablevisionhd';
  return null;
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

    // Para cablevisionhd y tvporinternet2, el slug está en el path
    const pathname = urlObj.pathname.replace(/^\//, '');
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
  const failedChannels: { id: string; error: string }[] = [];
  let processed = 0;

  for (const ch of channels) {
    if (!ch.url || !ch.url.includes('expires=') || !ch.refreshUrl) {
      continue;
    }

    pushLog('refreshExpired', `→ [${processed + 1}/${totalToProcess}] Procesando: ${ch.title || ch.id}`);

    const source = extractRefreshSource(ch.refreshUrl);
    if (!source) {
      pushLog('refreshExpired', `  ❌ Fuente no detectada en refreshUrl: ${ch.refreshUrl}`);
      failedChannels.push({ id: ch.id, error: 'Fuente no detectada' });
      processed++;
      updateSyncProgress('refreshExpired', processed, `[${processed}/${totalToProcess}] ${ch.title || ch.id} — fuente no detectada`, totalToProcess);
      continue;
    }
    pushLog('refreshExpired', `  Proveedor: ${source}`);

    const slug = extractSlugFromUrl(ch.refreshUrl, source);
    if (!slug) {
      pushLog('refreshExpired', `  ❌ No se pudo extraer slug de: ${ch.refreshUrl}`);
      failedChannels.push({ id: ch.id, error: 'slug inválido' });
      processed++;
      updateSyncProgress('refreshExpired', processed, `[${processed}/${totalToProcess}] ${ch.title || ch.id} — slug inválido`, totalToProcess);
      continue;
    }
    pushLog('refreshExpired', `  Slug extraído: ${slug}`);
    const fetchUrl = source === 'wsdeportes' ? `https://wsdeportes.net/?v=${slug}` :
      source === 'tvporinternet2' ? `https://www.tvporinternet2.com/${slug}.html` :
      source === 'cablevisionhd' ? `https://www.cablevisionhd.com/${slug}.php` :
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
        updatedChannels.push(ch);
      } else {
        pushLog('refreshExpired', `  ❌ El proveedor no devolvió URL`);
        pushLog('refreshExpired', `  🔍 Extrayendo manualmente desde ${fetchUrl}...`);
        try {
          const html = await fetchHTML(fetchUrl);
          const playerSrc = html.match(/<iframe[^>]+name=["']player["'][^>]+src=["']([^"']+)["']/i)?.[1] ||
                            html.match(/<iframe[^>]+src=["']([^"']+core[^"']+)["']/i)?.[1];
          if (playerSrc) {
            const fullUrl = playerSrc.startsWith('http') ? playerSrc : new URL(playerSrc, fetchUrl).href;
            pushLog('refreshExpired', `  Iframe player: ${fullUrl}`);
            pushLog('refreshExpired', `  Extrayendo stream desde iframe...`);
            const iframeHtml = await fetchHTML(fullUrl);
            const streamUrl = iframeHtml.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/i)?.[0] ||
                              iframeHtml.match(/file:\s*["']([^"']+)["']/i)?.[1] ||
                              iframeHtml.match(/src:\s*["']([^"']+(?:m3u8|ts|mp4)[^"']*)["']/i)?.[1] ||
                              iframeHtml.match(/source\s+src=["']([^"']+)["']/i)?.[1];
            if (streamUrl) {
              pushLog('refreshExpired', `  ✅ Stream encontrado manualmente: ${streamUrl.substring(0, 120)}`);
              ch.url = streamUrl;
              updatedChannels.push(ch);
              processed++;
              updateSyncProgress('refreshExpired', processed, `[${processed}/${totalToProcess}] ✅ ${ch.title || ch.id}`, totalToProcess);
              continue;
            }
            pushLog('refreshExpired', `  No se encontró stream en iframe`);
          } else {
            pushLog('refreshExpired', `  No se encontró iframe player`);
          }
        } catch (diagErr: any) {
          pushLog('refreshExpired', `  Error extracción manual: ${diagErr.message}`);
        }
        failedChannels.push({ id: ch.id, error: 'No se obtuvo URL del proveedor' });
        processed++;
        updateSyncProgress('refreshExpired', processed, `[${processed}/${totalToProcess}] ❌ ${ch.title || ch.id} — sin URL`, totalToProcess);
        continue;
      }
    } catch (error: any) {
      pushLog('refreshExpired', `  ❌ Error: ${error.message}`);
      failedChannels.push({ id: ch.id, error: error.message });
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
  const failedChannels: { id: string; error: string }[] = [];
  let processed = 0;

  for (const ch of channels) {
    if (!ch.refreshUrl) {
      continue;
    }

    pushLog('refreshAll', `→ [${processed + 1}/${totalToProcess}] Procesando: ${ch.title || ch.id}`);
    pushLog('refreshAll', `  refreshUrl: ${ch.refreshUrl}`);

    const provedor = (ch.proveedor || extractRefreshSource(ch.refreshUrl)) as string;
    if (provedor !== 'wsdeportes' && provedor !== 'cablevisionhd' && provedor !== 'tvporinternet2') {
      pushLog('refreshAll', `  ❌ Proveedor no soportado: ${provedor || '(none)'}`);
      failedChannels.push({ id: ch.id, error: `Proveedor no soportado: ${provedor || '(none)'}` });
      processed++;
      updateSyncProgress('refreshAll', processed, `[${processed}/${totalToProcess}] ${ch.title || ch.id} — proveedor no soportado`, totalToProcess);
      continue;
    }
    const source: 'wsdeportes' | 'cablevisionhd' | 'tvporinternet2' = provedor;
    pushLog('refreshAll', `  Proveedor: ${source}`);

    const slug = extractSlugFromUrl(ch.refreshUrl, source);
    if (!slug) {
      pushLog('refreshAll', `  ❌ No se pudo extraer slug de refreshUrl`);
      failedChannels.push({ id: ch.id, error: 'No se pudo extraer slug de refreshUrl' });
      processed++;
      updateSyncProgress('refreshAll', processed, `[${processed}/${totalToProcess}] ${ch.title || ch.id} — slug inválido`, totalToProcess);
      continue;
    }
    pushLog('refreshAll', `  Slug: ${slug}${ch.refreshOption ? ` | Opción: ${ch.refreshOption}` : ''}`);
    const fetchUrl = source === 'wsdeportes' ? `https://wsdeportes.net/?v=${slug}` :
      source === 'tvporinternet2' ? `https://www.tvporinternet2.com/${slug}.html` :
      source === 'cablevisionhd' ? `https://www.cablevisionhd.com/${slug}.php` :
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
        if (!ch.proveedor) ch.proveedor = source;
        updatedChannels.push(ch);
      } else {
        pushLog('refreshAll', `  ❌ El proveedor no devolvió URL`);
        pushLog('refreshAll', `  🔍 Extrayendo manualmente desde ${fetchUrl}...`);
        try {
          const html = await fetchHTML(fetchUrl);
          const playerSrc = html.match(/<iframe[^>]+name=["']player["'][^>]+src=["']([^"']+)["']/i)?.[1] ||
                            html.match(/<iframe[^>]+src=["']([^"']+core[^"']+)["']/i)?.[1];
          if (playerSrc) {
            const fullUrl = playerSrc.startsWith('http') ? playerSrc : new URL(playerSrc, fetchUrl).href;
            pushLog('refreshAll', `  Iframe player: ${fullUrl}`);
            pushLog('refreshAll', `  Extrayendo stream desde iframe...`);
            const iframeHtml = await fetchHTML(fullUrl);
            const streamUrl = iframeHtml.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|m3u)[^\s"'<>]*/i)?.[0] ||
                              iframeHtml.match(/file:\s*["']([^"']+)["']/i)?.[1] ||
                              iframeHtml.match(/src:\s*["']([^"']+(?:m3u8|ts|mp4)[^"']*)["']/i)?.[1] ||
                              iframeHtml.match(/source\s+src=["']([^"']+)["']/i)?.[1];
            if (streamUrl) {
              pushLog('refreshAll', `  ✅ Stream encontrado manualmente: ${streamUrl.substring(0, 120)}`);
              ch.url = streamUrl;
              if (!ch.proveedor) ch.proveedor = source;
              updatedChannels.push(ch);
              processed++;
              updateSyncProgress('refreshAll', processed, `[${processed}/${totalToProcess}] ✅ ${ch.title || ch.id}`, totalToProcess);
              continue;
            }
            pushLog('refreshAll', `  No se encontró stream en iframe`);
          } else {
            pushLog('refreshAll', `  No se encontró iframe player`);
          }
        } catch (diagErr: any) {
          pushLog('refreshAll', `  Error extracción manual: ${diagErr.message}`);
        }
        failedChannels.push({ id: ch.id, error: 'No se obtuvo URL del proveedor' });
        processed++;
        updateSyncProgress('refreshAll', processed, `[${processed}/${totalToProcess}] ❌ ${ch.title || ch.id} — sin URL`, totalToProcess);
        continue;
      }
    } catch (error: any) {
      pushLog('refreshAll', `  ❌ Error: ${error.message}`);
      failedChannels.push({ id: ch.id, error: error.message });
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
    const result = await getChannelStream('tvporinternet2', slug, option || undefined);
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
    return reply.send({ ok: true, channel: channelData, message: 'Channel added at the beginning of the list' });
  } catch (error) {
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
    const result = await getChannelStream('cablevisionhd', slug, option || undefined);
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
    return reply.send({ ok: true, channel: channelData, message: 'Channel added at the beginning of the list' });
  } catch (error) {
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
    const result = await getChannelStream('wsdeportes', parameter);
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
    return reply.send({ ok: true, channel: channelData, message: 'Channel added at the beginning of the list' });
  } catch (error) {
    return reply.status(500).send({ error: 'Failed to add channel' });
  }
}
