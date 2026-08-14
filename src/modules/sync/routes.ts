import { FastifyInstance } from 'fastify';
import { getSyncStatus, subscribeSyncEvents, getLogsByPrefix } from '../../services/sync-status';
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
  syncGnulahdHomeHandler,
  syncGnulahdMoviesHandler,
  syncGnulahdSeriesHandler,
  syncGnulahdAnimeHandler,
  fetchDetailsHandler,
  syncStatusHandler,
  syncCountsHandler,
  syncCountHandler,
  syncDetailHandler,
  clearLogsHandler,
  migrateToFirestoreHandler,
  migrationStatusHandler,
  runFirestoreToSupabaseHandler,
  firestoreToSupabaseStatusHandler,
  getAutoRefreshHandler,
  setAutoRefreshHandler,
  getGnulahdAutoSyncHandler,
  setGnulahdAutoSyncHandler,
  listGnulahdItemsHandler,
  syncGnulahdItemHandler,
} from './controller';

export async function syncRoutes(app: FastifyInstance) {
  app.get('/sync/events', async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ type: 'status', status: getSyncStatus() });
    const unsubscribe = subscribeSyncEvents(send);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  app.get('/sync/provider-logs', async (_request, reply) => reply.send(getLogsByPrefix('refreshProvider:')));

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
  app.post('/sync/gnulahd/home', syncGnulahdHomeHandler);
  app.post('/sync/gnulahd/movies', syncGnulahdMoviesHandler);
  app.post('/sync/gnulahd/series', syncGnulahdSeriesHandler);
  app.post('/sync/gnulahd/anime', syncGnulahdAnimeHandler);
  app.post('/sync/fetch-details', fetchDetailsHandler);
  app.get('/sync/status', syncStatusHandler);
  app.get('/sync/counts', syncCountsHandler);
  app.get('/sync/count/:type', syncCountHandler);
  app.get('/sync/detail/:type', syncDetailHandler);
  app.post('/sync/clear-logs/:type', clearLogsHandler);
  app.post('/sync/migrate-to-firestore', migrateToFirestoreHandler);
  app.get('/sync/migration-status', migrationStatusHandler);
  app.post('/sync/migrate-firestore-to-supabase', runFirestoreToSupabaseHandler);
  app.get('/sync/firestore-to-supabase-status', firestoreToSupabaseStatusHandler);
  app.get('/sync/auto-refresh', getAutoRefreshHandler);
  app.post('/sync/auto-refresh', setAutoRefreshHandler);
  app.get('/sync/gnulahd/auto', getGnulahdAutoSyncHandler);
  app.post('/sync/gnulahd/auto', setGnulahdAutoSyncHandler);
  app.get('/sync/gnulahd/items', listGnulahdItemsHandler);
  app.post('/sync/gnulahd/item', syncGnulahdItemHandler);
}
