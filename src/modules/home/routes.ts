import { FastifyInstance } from 'fastify';
import { getHomeHandler, getHomeNewHandler, playerHandler } from './controller';

export async function homeRoutes(app: FastifyInstance) {
  app.get('/home', getHomeHandler);
  app.get('/home-new', getHomeNewHandler);
  app.get('/player/:mediaType/:id', playerHandler);
}
