import { FastifyInstance } from 'fastify';
import { getMoviesHandler, getMovieDetailHandler } from './controller';

export async function movieRoutes(app: FastifyInstance) {
  app.get('/movies', getMoviesHandler);
  app.get('/movies/:id', getMovieDetailHandler);
}
