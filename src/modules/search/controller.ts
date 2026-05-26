import { FastifyRequest, FastifyReply } from 'fastify';
import { searchAll, searchByType } from './service';

export async function searchHandler(request: FastifyRequest, reply: FastifyReply) {
  const { q, type, page = '1' } = request.query as any;

  if (!q || (q as string).length < 2) {
    return reply.send({ items: [], total: 0, query: q || '' });
  }

  const pageNum = parseInt(page) || 1;

  let results;
  if (type && ['movie', 'series', 'live'].includes(type)) {
    results = await searchByType(q, type as any, pageNum);
  } else {
    results = await searchAll(q, pageNum);
  }

  return reply.send(results);
}
