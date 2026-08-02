import { FastifyInstance } from 'fastify';
import { getMoviesHandler, getMovieDetailHandler, getEstrenosMoviesHandler, getEstrenosSeriesHandler } from './controller';

export async function movieRoutes(app: FastifyInstance) {
  app.get('/estrenos/movies', getEstrenosMoviesHandler);
  app.get('/estrenos/series', getEstrenosSeriesHandler);
  app.get('/movies', getMoviesHandler);
  app.get('/movies/:id', getMovieDetailHandler);
}
