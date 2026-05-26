import { FastifyInstance } from 'fastify';
import {
  syncMoviesHandler,
  syncSeriesHandler,
  syncAllHandler,
  syncLiveHandler,
  syncPopularMoviesHandler,
  syncPopularSeriesHandler,
  importM3UHandler,
} from './controller';

export async function syncRoutes(app: FastifyInstance) {
  app.post('/sync/movies', syncMoviesHandler);
  app.post('/sync/series', syncSeriesHandler);
  app.post('/sync/all', syncAllHandler);
  app.post('/sync/live', syncLiveHandler);
  app.post('/sync/popular/movies', syncPopularMoviesHandler);
  app.post('/sync/popular/series', syncPopularSeriesHandler);
  app.post('/sync/live/import', importM3UHandler);
}
