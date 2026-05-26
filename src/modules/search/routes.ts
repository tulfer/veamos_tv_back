import { FastifyInstance } from 'fastify';
import { searchHandler } from './controller';

export async function searchRoutes(app: FastifyInstance) {
  app.get('/search', searchHandler);
}
