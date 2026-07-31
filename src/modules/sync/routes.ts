import { FastifyInstance } from 'fastify';
import {
  syncMoviesHandler,
  syncSeriesHandler,
  syncAllHandler,
  syncLiveHandler,
  syncPopularMoviesHandler,
  syncPopularSeriesHandler,
  syncEstrenoMoviesHandler,
  syncEstrenoSeriesHandler,
  importM3UHandler,
  syncHomeByscHandler,
  fetchDetailsHandler,
  syncStatusHandler,
  syncCountsHandler,
  syncDetailHandler,
  clearLogsHandler,
  migrateToFirestoreHandler,
  migrationStatusHandler,
} from './controller';

export async function syncRoutes(app: FastifyInstance) {
  app.post('/sync/movies', syncMoviesHandler);
  app.post('/sync/series', syncSeriesHandler);
  app.post('/sync/all', syncAllHandler);
  app.post('/sync/estrenos/movies', syncEstrenoMoviesHandler);
  app.post('/sync/estrenos/series', syncEstrenoSeriesHandler);
  app.post('/sync/live', syncLiveHandler);
  app.post('/sync/popular/movies', syncPopularMoviesHandler);
  app.post('/sync/popular/series', syncPopularSeriesHandler);
  app.post('/sync/live/import', importM3UHandler);
  app.post('/sync/home-bysc', syncHomeByscHandler);
  app.post('/sync/fetch-details', fetchDetailsHandler);
  app.get('/sync/status', syncStatusHandler);
  app.get('/sync/counts', syncCountsHandler);
  app.get('/sync/detail/:type', syncDetailHandler);
  app.post('/sync/clear-logs/:type', clearLogsHandler);
  app.post('/sync/migrate-to-firestore', migrateToFirestoreHandler);
  app.get('/sync/migration-status', migrationStatusHandler);
}
