import { FastifyRequest, FastifyReply } from 'fastify';
import { searchAll, searchByType } from './service';
import { dispatchPushTask } from '../../services/push';

export async function searchHandler(request: FastifyRequest, reply: FastifyReply) {
  const { q, type, page = '1' } = request.query as any;

  if (!q || (q as string).length < 2) {
    return reply.send({ items: [], total: 0, query: q || '' });
  }

  const pageNum = parseInt(page) || 1;

  let results;
  if (type && ['movie', 'series', 'anime', 'live'].includes(type)) {
    results = await searchByType(q, type as any, pageNum);
  } else {
    results = await searchAll(q, pageNum);
  }

  // Si GNULA no aportó ningún resultado (bloqueado en dokploy), se pide a la
  // app móvil (vía push) que busque en GNULA desde la IP residencial y suba
  // los ítems; la próxima búsqueda ya los mezcla.
  const gnulaFound = (results.items ?? []).some((item: any) => item.source === 'gnula');
  if (!gnulaFound) {
    const searchType = type && ['movie', 'series', 'anime'].includes(type) ? type : undefined;
    dispatchPushTask({ task: 'search', query: q, type: searchType as any }).catch(() => {});
  }

  return reply.send(results);
}
