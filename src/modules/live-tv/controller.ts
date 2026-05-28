import { FastifyRequest, FastifyReply } from 'fastify';
import { fetchLiveChannels, getChannelsByGroup, getChannelsByCountry, getChannelGroups } from '../../providers/live-tv';
import { getChannelStream } from '../../providers/custom-channels';
import { getCachedOrFetch, memoryCache } from '../../cache';
import { loadSyncData, saveSyncData } from '../../services/data-store';
import { LiveChannel } from '../../types';
import { logger } from '../../utils/logger';

const CACHE_KEY = 'live:channels';
const PAGE_SIZE = 10;

export async function getChannelsHandler(request: FastifyRequest, reply: FastifyReply) {
  const { group, country, all, page = '1' } = request.query as any;
  const pageNum = parseInt(page) || 1;
  const showAll = all === 'true' || all === '1';

  const synced = loadSyncData();
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
  const synced = loadSyncData();
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
    const existing = loadSyncData();
    const channels = existing?.channels || [];

    // Buscar si ya existe
    const existingIndex = channels.findIndex((ch) => ch.id === result.id);
    if (existingIndex !== -1) {
      // Mover al inicio
      channels.splice(existingIndex, 1);
    }
    // Agregar al inicio
    channels.unshift(result);

    saveSyncData({
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
  const synced = loadSyncData();
  if (!synced || !Array.isArray(synced.channels)) {
    return reply.status(400).send({ error: 'No sync data found' });
  }

  const channels = synced.channels;
  const updatedChannels: LiveChannel[] = [];
  const failedChannels: { id: string; error: string }[] = [];

  for (const ch of channels) {
    // Verificar si la URL tiene "expires" y tiene refreshUrl
    if (!ch.url || !ch.url.includes('expires=') || !ch.refreshUrl) {
      continue;
    }

    const source = extractRefreshSource(ch.refreshUrl);
    if (!source) {
      continue;
    }

    const slug = extractSlugFromUrl(ch.refreshUrl, source);
    if (!slug) {
      continue;
    }

    try {
      logger.info({ id: ch.id, source, slug, option: ch.refreshOption }, 'Refreshing channel URL');

      const result = await getChannelStream(source, slug, ch.refreshOption || undefined);
      if (result && result.url && !result.url.includes('expires=')) {
        // Actualizar solo la URL
        ch.url = result.url;
        updatedChannels.push(ch);
        logger.info({ id: ch.id, url: ch.url?.substring(0, 80) }, 'Channel URL refreshed successfully');
      } else {
        failedChannels.push({ id: ch.id, error: 'New URL still has expires or is empty' });
        logger.warn({ id: ch.id }, 'New URL still has expires or is empty');
      }
    } catch (error: any) {
      failedChannels.push({ id: ch.id, error: error.message });
      logger.error({ id: ch.id, error: error.message }, 'Failed to refresh channel URL');
    }
  }

  // Guardar los cambios si se actualizó algún canal
  if (updatedChannels.length > 0) {
    saveSyncData({
      ...synced,
      channels,
      updatedAt: Date.now(),
    });
    memoryCache.del('live:channels');
  }

  return reply.send({
    ok: true,
    message: `Refreshed ${updatedChannels.length} channels, ${failedChannels.length} failed`,
    updated: updatedChannels.map((ch) => ({ id: ch.id })),
    failed: failedChannels,
  });
}

/**
 * Actualiza la URL de los canales que tengan refreshUrl, usando el proveedor
 * especificado en el campo "proveedor" del objeto del canal.
 * Lee el archivo data/sync-data.json.channels.json y actualiza solo la url.
 */
export async function refreshAllChannelsHandler(_request: FastifyRequest, reply: FastifyReply) {
  const synced = loadSyncData();
  if (!synced || !Array.isArray(synced.channels)) {
    return reply.status(400).send({ error: 'No sync data found' });
  }

  const channels = synced.channels;
  const updatedChannels: LiveChannel[] = [];
  const failedChannels: { id: string; error: string }[] = [];

  for (const ch of channels) {
    // Solo procesar canales que tengan refreshUrl
    if (!ch.refreshUrl) {
      continue;
    }

    // Inferir el proveedor desde el campo "proveedor" o desde la refreshUrl
    const provedor = (ch.proveedor || extractRefreshSource(ch.refreshUrl)) as string;
    if (provedor !== 'wsdeportes' && provedor !== 'cablevisionhd' && provedor !== 'tvporinternet2') {
      failedChannels.push({ id: ch.id, error: `Proveedor no soportado: ${provedor || '(none)'}` });
      logger.warn({ id: ch.id, refreshUrl: ch.refreshUrl, proveedor: ch.proveedor }, 'Proveedor no soportado');
      continue;
    }
    const source: 'wsdeportes' | 'cablevisionhd' | 'tvporinternet2' = provedor;

    // Extraer slug de la refreshUrl según el proveedor
    const slug = extractSlugFromUrl(ch.refreshUrl, source);
    if (!slug) {
      failedChannels.push({ id: ch.id, error: 'No se pudo extraer slug de refreshUrl' });
      logger.warn({ id: ch.id, refreshUrl: ch.refreshUrl, proveedor: source }, 'No se pudo extraer slug');
      continue;
    }

    try {
      logger.info({ id: ch.id, proveedor: source, slug, option: ch.refreshOption }, 'Refrescando URL del canal');

      // Invalidar caché en memoria para forzar una consulta fresca
      memoryCache.del(`${source}:${slug}`);
      memoryCache.del(`${source}:${slug}:default`);
      if (ch.refreshOption) memoryCache.del(`${source}:${slug}:${ch.refreshOption}`);
      const result = await getChannelStream(source, slug, ch.refreshOption || undefined);
      if (result && result.url) {
        // Actualizar solo la URL y asegurar el proveedor en el canal
        ch.url = result.url;
        if (!ch.proveedor) ch.proveedor = source;
        updatedChannels.push(ch);
        logger.info({ id: ch.id, url: ch.url?.substring(0, 80) }, 'URL del canal actualizada exitosamente');
      } else {
        failedChannels.push({ id: ch.id, error: 'No se obtuvo URL del proveedor' });
        logger.warn({ id: ch.id }, 'No se obtuvo URL del proveedor');
      }
    } catch (error: any) {
      failedChannels.push({ id: ch.id, error: error.message });
      logger.error({ id: ch.id, error: error.message }, 'Error al refrescar URL del canal');
    }
  }

  // Guardar los cambios si se actualizó algún canal
  if (updatedChannels.length > 0) {
    saveSyncData({
      ...synced,
      channels,
      updatedAt: Date.now(),
    });
    memoryCache.del('live:channels');
  }

  return reply.send({
    ok: true,
    message: `URLs actualizadas: ${updatedChannels.length}, fallos: ${failedChannels.length}`,
    updated: updatedChannels.map((ch) => ({ id: ch.id, title: ch.title })),
    failed: failedChannels,
  });
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
    const existing = loadSyncData();
    const channels = existing?.channels || [];

    // Buscar si ya existe
    const existingIndex = channels.findIndex((ch) => ch.id === channelData.id);
    if (existingIndex !== -1) {
      // Mover al inicio
      channels.splice(existingIndex, 1);
    }
    // Agregar al inicio
    channels.unshift(channelData);

    saveSyncData({
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
    const existing = loadSyncData();
    const channels = existing?.channels || [];

    // Buscar si ya existe
    const existingIndex = channels.findIndex((ch) => ch.id === channelData.id);
    if (existingIndex !== -1) {
      // Mover al inicio
      channels.splice(existingIndex, 1);
    }
    // Agregar al inicio
    channels.unshift(channelData);

    saveSyncData({
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
    const existing = loadSyncData();
    const channels = existing?.channels || [];

    // Buscar si ya existe
    const existingIndex = channels.findIndex((ch) => ch.id === channelData.id);
    if (existingIndex !== -1) {
      // Mover al inicio
      channels.splice(existingIndex, 1);
    }
    // Agregar al inicio
    channels.unshift(channelData);

    saveSyncData({
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
