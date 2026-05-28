import { FastifyInstance } from 'fastify';
import { getHomeHandler, getHomeNewHandler } from './controller';

export async function homeRoutes(app: FastifyInstance) {
  app.get('/home', getHomeHandler);
  app.get('/home-new', getHomeNewHandler);
}
