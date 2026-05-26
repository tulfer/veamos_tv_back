import { FastifyInstance } from 'fastify';
import { getHomeHandler } from './controller';

export async function homeRoutes(app: FastifyInstance) {
  app.get('/home', getHomeHandler);
}
