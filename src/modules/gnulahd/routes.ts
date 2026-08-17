import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'node:path';
import { loadChannels, loadSyncData } from '../../services/data-store';
import { loadGnulahdHomeData, normalizeGnulahdItemId, scrapeGnulahdList } from '../../providers/gnulahd';
import { getGnulahdDetailContent } from '../../services/gnulahd-content';
import { unwrapDetailProxy } from '../../services/content-detail';
import { getChannelsHandler } from '../live-tv/controller';
import { verifyDeviceCode } from '../../services/device-codes';
import { searchAll, searchByType } from '../search/service';

const PAGE_SIZE = 32;

function paginate<T>(items: T[], page: number, limit: number) {
  const total = items.length;
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), items: items.slice((page - 1) * limit, page * limit) };
}

async function homeWithLiveChannels() {
  const data = await loadGnulahdHomeData();
  if (!data) return null;
  const channels = await loadChannels();
  const liveSection = {
    title: 'TV en Vivo',
    type: 'live' as const,
    items: channels.slice(0, 20).map(channel => ({ id: channel.id, title: channel.title, poster: channel.logo, url: channel.url, type: 'live' as const, drm: channel.drm, proveedor: channel.proveedor })),
    seeAllRoute: '/live/channels',
    totalItems: channels.length,
  };
  const sections = [...data.sections.filter(section => section.type !== 'live'), liveSection].map(section => ({
    ...section,
    seeAllRoute: section.type === 'live'
      ? '/live/channels'
      : section.type === 'anime'
        ? '/anime'
        : `/${section.type}`,
    items: section.items.map(item => {
      const { backdrop, ...rest } = item;
      return { ...rest, poster: backdrop || item.poster, title2: backdrop };
    }),
  }));
  const banners = data.banners.map(banner => {
    const { backdrop, ...rest } = banner;
    return { ...rest, poster: backdrop || banner.poster, title2: backdrop };
  });
  return { ...data, banners, sections };
}

function registerGnulahdPrefix(app: FastifyInstance, prefix: '/v2' | '/gnulahd' | '/v2/:code') {
  app.get(`${prefix}/home`, async (_request: FastifyRequest, reply: FastifyReply) => {
    const data = await homeWithLiveChannels();
    if (!data) return reply.status(404).send({ error: 'Home de GNULA aún no sincronizado', hint: 'Ejecuta POST /sync/gnulahd/home primero' });
    return reply.send(data);
  });

  for (const [kind, collection] of [['movies', 'gnulahdMovies'], ['series', 'gnulahdSeries'], ['anime', 'gnulahdAnime']] as const) {
    app.get(`${prefix}/${kind}`, async (request: FastifyRequest, reply: FastifyReply) => {
      const synced = await loadSyncData();
      const query = request.query as { page?: string; limit?: string };
      const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
      const limit = Math.min(60, Math.max(1, parseInt(query.limit || String(PAGE_SIZE), 10) || PAGE_SIZE));
      // El detalle queda persistido para /content, pero no se duplica en cada
      // respuesta de listado.
      const items = ((synced?.[collection] || []) as unknown as Array<Record<string, unknown>>)
        .map((item) => normalizeGnulahdItemId(item as { id: string; type: 'movie' | 'series' | 'anime' | 'live' }) as Record<string, unknown>)
        .map(({ content: _content, ...item }) => item);
      return reply.send(paginate(items, page, limit));
    });
  }

  app.get(`${prefix}/live/channels`, getChannelsHandler);

  app.get(`${prefix}/content/:id`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id?: string };
    if (!id) return reply.status(400).send({ error: 'Missing or invalid content ID' });
    const detail = await getGnulahdDetailContent(id);
    if (!detail) return reply.status(404).send({ error: 'Content not found', id });
    return reply.send(unwrapDetailProxy(detail));
  });

  app.get(`${prefix}/search`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { q, type } = request.query as { q?: string; type?: string };
    if (!q || (q as string).length < 2) return reply.send({ items: [], total: 0, query: q || '' });
    if (type && ['movie', 'series', 'live'].includes(type)) {
      return reply.send(await searchByType(q, type as any));
    }
    return reply.send(await searchAll(q));
  });

  app.get(`${prefix}/list/:kind`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { kind } = request.params as { kind?: string };
    if (!kind || !['peliculas', 'series', 'anime'].includes(kind)) return reply.status(400).send({ error: 'Kind must be peliculas, series or anime' });
    const page = Math.max(1, parseInt(((request.query as { page?: string }).page || '1'), 10) || 1);
    return reply.send(await scrapeGnulahdList(kind as 'peliculas' | 'series' | 'anime', page));
  });
}

export async function gnulahdRoutes(app: FastifyInstance) {
  registerGnulahdPrefix(app, '/v2');
  // Compatibilidad para clientes que todavía usan el prefijo anterior.
  registerGnulahdPrefix(app, '/gnulahd');

  // Variante protegida por código de dispositivo: /v2/<codigo>/...
  // El código debe existir, estar habilitado y vinculado a un dispositivo.
  // Si el cliente envía su deviceId (header x-device-id o query deviceId)
  // además se verifica que sea el dispositivo dueño del código.
  app.register(async (scope) => {
    scope.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const { code } = request.params as { code?: string };
      const deviceId = (request.headers['x-device-id'] as string) || ((request.query as { deviceId?: string })?.deviceId || '');
      const result = await verifyDeviceCode(code, deviceId || undefined);
      if (!result.ok) {
        return reply.status(result.status || 403).send({ error: result.reason });
      }
    });
    registerGnulahdPrefix(scope, '/v2/:code');
    // Landing page de la app, protegida por código: /v2/<codigo>/app
    scope.get('/v2/:code/app', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header('content-type', 'text/html; charset=utf-8');
      return reply.sendFile('landing.html', path.join(process.cwd(), 'public'));
    });
  });
}
