import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadSyncData, loadChannels } from '../../services/data-store';
import { loadGnulahdHomeData, normalizeGnulahdItemId, scrapeGnulahdList, searchGnulahd } from '../../providers/gnulahd';
import { getGnulahdDetailContent } from '../../services/gnulahd-content';
import { unwrapDetailProxy } from '../../services/content-detail';
import { getChannelsHandler } from '../live-tv/controller';

const PAGE_SIZE = 20;

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
    items: channels.map(channel => ({ id: channel.id, title: channel.title, poster: channel.logo, type: 'live' as const })),
    seeAllRoute: '/v2/live/channels',
    totalItems: channels.length,
  };
  const sections = [...data.sections.filter(section => section.type !== 'live'), liveSection].map(section => ({
    ...section,
    seeAllRoute: section.type === 'live'
      ? '/v2/live/channels'
      : section.type === 'anime'
        ? '/v2/anime'
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

function registerGnulahdPrefix(app: FastifyInstance, prefix: '/v2' | '/gnulahd') {
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
    const q = ((request.query as { q?: string }).q || '').trim();
    if (!q) return reply.status(400).send({ error: 'Provide q query param' });
    return reply.send({ ...(await searchGnulahd(q)), query: q });
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
}
