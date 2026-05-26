import { FastifyInstance } from 'fastify';
import { getSeriesHandler, getSeriesDetailHandler, getSeasonEpisodesHandler } from './controller';

export async function seriesRoutes(app: FastifyInstance) {
  app.get('/series', getSeriesHandler);
  app.get('/series/:id', getSeriesDetailHandler);
  app.get('/series/:id/seasons/:seasonNumber', getSeasonEpisodesHandler);
}
