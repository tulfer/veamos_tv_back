import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadSyncData } from '../../services/data-store';
import { loadGnulahdHomeData, scrapeGnulahdList, searchGnulahd } from '../../providers/gnulahd';
import { getGnulahdDetailContent } from '../../services/gnulahd-content';
import { unwrapDetailProxy } from '../../services/content-detail';

const PAGE_SIZE = 20;

function paginate<T>(items: T[], page: number, limit: number): { page: number; limit: number; total: number; totalPages: number; items: T[] } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  return { page, limit, total, totalPages, items: items.slice(start, start + limit) };
}

export async function gnulahdRoutes(app: FastifyInstance) {
  app.get('/gnulahd/home', async (_request: FastifyRequest, reply: FastifyReply) => {
    const data = await loadGnulahdHomeData();
    if (!data) {
      return reply.status(404).send({
        error: 'Home de GNULA aún no sincronizado',
        hint: 'Ejecuta POST /sync/gnulahd/home primero',
      });
    }
    return reply.send(data);
  });

  app.get('/gnulahd/movies', async (request: FastifyRequest, reply: FastifyReply) => {
    const synced = await loadSyncData();
    const query = request.query as { page?: string; limit?: string };
    const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
    const limit = Math.min(60, Math.max(1, parseInt(query.limit || String(PAGE_SIZE), 10) || PAGE_SIZE));
    return reply.send(paginate(synced?.gnulahdMovies || [], page, limit));
  });

  app.get('/gnulahd/series', async (request: FastifyRequest, reply: FastifyReply) => {
    const synced = await loadSyncData();
    const query = request.query as { page?: string; limit?: string };
    const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
    const limit = Math.min(60, Math.max(1, parseInt(query.limit || String(PAGE_SIZE), 10) || PAGE_SIZE));
    return reply.send(paginate(synced?.gnulahdSeries || [], page, limit));
  });

  app.get('/gnulahd/anime', async (request: FastifyRequest, reply: FastifyReply) => {
    const synced = await loadSyncData();
    const query = request.query as { page?: string; limit?: string };
    const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
    const limit = Math.min(60, Math.max(1, parseInt(query.limit || String(PAGE_SIZE), 10) || PAGE_SIZE));
    return reply.send(paginate(synced?.gnulahdAnime || [], page, limit));
  });

  app.get('/gnulahd/content/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id?: string };
    if (!id || typeof id !== 'string') {
      return reply.status(400).send({ error: 'Missing or invalid content ID' });
    }
    const detail = await getGnulahdDetailContent(id);
    if (!detail) {
      return reply.status(404).send({ error: 'Content not found', id });
    }
    return reply.send(unwrapDetailProxy(detail));
  });

  app.get('/gnulahd/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { q?: string };
    const q = (query.q || '').trim();
    if (!q) {
      return reply.status(400).send({ error: 'Provide q query param' });
    }
    const result = await searchGnulahd(q);
    return reply.send({ ...result, query: q });
  });

  app.get('/gnulahd/list/:kind', async (request: FastifyRequest, reply: FastifyReply) => {
    const { kind } = request.params as { kind?: string };
    const query = request.query as { page?: string };
    if (!kind || !['peliculas', 'series', 'anime'].includes(kind)) {
      return reply.status(400).send({ error: 'Kind must be peliculas, series or anime' });
    }
    const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
    const result = await scrapeGnulahdList(kind as 'peliculas' | 'series' | 'anime', page);
    return reply.send(result);
  });
}
