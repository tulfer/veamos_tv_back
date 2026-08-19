import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'node:path';
import { Section } from '../../types';
import { loadSyncData } from '../../services/data-store';
import { loadGnulahdHomeData, normalizeGnulahdItemId, scrapeGnulahdList } from '../../providers/gnulahd';
import { loadAnimeHomeData } from '../../providers/anime';
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
  // El home se limita a películas y series: se descartan las secciones de
  // anime y de TV en vivo (los canales viven en /live/channels).
  const sections = data.sections.filter(section => section.type !== 'live' && section.type !== 'anime').map(section => ({
    ...section,
    seeAllRoute: `/${section.type}`,
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

function registerGnulahdPrefix(app: FastifyInstance, prefix: '/v2/:code') {
  app.get(`${prefix}/home`, async (_request: FastifyRequest, reply: FastifyReply) => {
    const data = await homeWithLiveChannels();
    if (!data) return reply.status(404).send({ error: 'Home de GNULA aún no sincronizado', hint: 'Ejecuta POST /sync/gnulahd/home primero' });
    return reply.send(data);
  });

  for (const [kind, collection] of [['movies', 'gnulahdMovies'], ['series', 'gnulahdSeries']] as const) {
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

  // Sección Anime: banner + calendario del día (latanime) + últimos episodios
  // (jkanime) + últimas temporadas (latanime) + Top Anime (jkanime)
  // + catálogo completo (Todos, jkanime directorio). La primera página
  // devuelve la estructura con secciones; páginas siguientes solo el listado.
  app.get(`${prefix}/anime`, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { page?: string; limit?: string };
    const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
    const data = await loadAnimeHomeData();
    const todos = data?.todos || [];
    const limit = Math.min(60, Math.max(1, parseInt(query.limit || '20', 10) || 20));
    if (page > 1) {
      return reply.send({ page, limit, total: todos.length, totalPages: Math.max(1, Math.ceil(todos.length / limit)), items: todos.slice((page - 1) * limit, page * limit) });
    }
    if (!data) {
      return reply.status(404).send({ error: 'Sección anime aún no sincronizada', hint: 'Ejecuta el sync de anime primero' });
    }
    const sections: Section[] = [];
    if (data.calendario?.items?.length) {
      sections.push({ title: `Calendario Latino - ${data.calendario.day}`, type: 'anime', items: data.calendario.items, seeAllRoute: '/anime', totalItems: data.calendario.items.length });
    }
    sections.push(
      { title: 'Ultimos episodios', type: 'anime', items: data.ultimosEpisodios, seeAllRoute: '/anime', totalItems: data.ultimosEpisodios.length },
      { title: 'Ultimas Temporadas Latino', type: 'anime', items: data.ultimasTemporadas || [], seeAllRoute: '/anime', totalItems: (data.ultimasTemporadas || []).length },
      { title: 'Top Anime', type: 'anime', items: data.topAnime, seeAllRoute: '/anime', totalItems: data.topAnime.length },
      { title: 'Todos', type: 'anime', items: todos.slice(0, 20), seeAllRoute: '/anime', totalItems: todos.length },
    );
    return reply.send({ banners: data.banners, sections, updatedAt: data.updatedAt });
  });

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
  // Solo se expone la variante protegida por código de dispositivo: /v2/<codigo>/...
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
