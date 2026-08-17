import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { env } from './config/env';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/error';
import { ensureStoreTable } from './services/store';

import { authRoutes } from './modules/auth/routes';
import { userRoutes } from './modules/users/routes';
import { movieRoutes } from './modules/movies/routes';
import { seriesRoutes } from './modules/series/routes';
import { liveTVRoutes } from './modules/live-tv/routes';
import { searchRoutes } from './modules/search/routes';
import { homeRoutes } from './modules/home/routes';
import { contentRoutes } from './modules/content/routes';
import { deviceRoutes } from './modules/devices/routes';
import { gnulahdRoutes } from './modules/gnulahd/routes';
import { syncRoutes } from './modules/sync/routes';
import { dbExplorerRoutes } from './modules/db-explorer/routes';
import { proxyRoutes } from './modules/proxy/routes';
import { playerRoutes } from './modules/player/routes';
import { startAutoRefreshScheduler } from './services/auto-refresh';
import { startGnulahdAutoSyncScheduler } from './services/auto-sync-gnulahd';
import { hydrateSyncState } from './services/sync-status';
import { migrateProviderChannelIds } from './services/data-store';

process.stderr.write('=== Veamos TV API starting ===\n');
process.stderr.write(`Node version: ${process.version}\n`);
process.stderr.write(`PORT env: ${process.env.PORT || '(unset)'}\n`);
process.stderr.write(`HOST env: ${process.env.HOST || '(unset)'}\n`);

process.on('uncaughtException', (err) => {
  process.stderr.write(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}\n`);
});
process.on('unhandledRejection', (err: any) => {
  process.stderr.write(`UNHANDLED REJECTION: ${err?.message || err}\n`);
});

async function buildServer() {
  process.stderr.write('buildServer: creating Fastify instance...\n');

  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
  });

  app.setErrorHandler(errorHandler);

  process.stderr.write('buildServer: registering cors...\n');
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  process.stderr.write('buildServer: registering sensible...\n');
  try {
    await app.register(sensible);
  } catch (e) {
    process.stderr.write(`Warning: sensible plugin failed to register: ${e}\n`);
  }

  process.stderr.write('buildServer: registering dashboard assets...\n');
  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public/dashboard'),
    prefix: '/dashboard-assets/',
  });
  app.get('/sync/app', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/mipanel', async (_request, reply) => reply.sendFile('mipanel.html'));

  process.stderr.write('buildServer: registering authRoutes...\n');
  await app.register(authRoutes);

  process.stderr.write('buildServer: registering userRoutes...\n');
  await app.register(userRoutes);

  process.stderr.write('buildServer: registering movieRoutes...\n');
  await app.register(movieRoutes);

  process.stderr.write('buildServer: registering seriesRoutes...\n');
  await app.register(seriesRoutes);

  process.stderr.write('buildServer: registering liveTVRoutes...\n');
  await app.register(liveTVRoutes);

  process.stderr.write('buildServer: registering searchRoutes...\n');
  await app.register(searchRoutes);

  process.stderr.write('buildServer: registering homeRoutes...\n');
  await app.register(homeRoutes);

  process.stderr.write('buildServer: registering contentRoutes...\n');
  await app.register(contentRoutes);

  process.stderr.write('buildServer: registering gnulahdRoutes...\n');
  await app.register(gnulahdRoutes);

  process.stderr.write('buildServer: registering deviceRoutes...\n');
  await app.register(deviceRoutes);

  process.stderr.write('buildServer: registering syncRoutes...\n');
  await app.register(syncRoutes);

  process.stderr.write('buildServer: registering dbExplorerRoutes...\n');
  await app.register(dbExplorerRoutes);

  process.stderr.write('buildServer: registering proxyRoutes...\n');
  await app.register(proxyRoutes);

  process.stderr.write('buildServer: registering playerRoutes...\n');
  await app.register(playerRoutes);

  process.stderr.write('buildServer: registering root routes...\n');

  app.get('/', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.sendFile('landing.html', path.join(process.cwd(), 'public'));
  });
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: Date.now(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  }));

  return app;
}

async function start() {
  try {
    process.stderr.write('start: verificando tabla store (Supabase)...\n');
    await ensureStoreTable();
    process.stderr.write('start: migrando IDs de canales por proveedor...\n');
    await migrateProviderChannelIds();

    process.stderr.write('start: restaurando estado y logs de sincronización...\n');
    await hydrateSyncState();

    process.stderr.write('start: building server...\n');
    const app = await buildServer();
    const port = parseInt(process.env.PORT || '8080', 10);
    const host = process.env.HOST || '0.0.0.0';
    process.stderr.write(`start: listening on ${host}:${port}...\n`);
    await app.listen({ port, host });
    process.stderr.write(`start: server listening on ${host}:${port}\n`);
    logger.info({ port, host, env: env.NODE_ENV }, 'Veamos TV API started');

    try {
      startAutoRefreshScheduler();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`WARN: No se pudo iniciar el programador de auto-refresh - ${msg}\n`);
      logger.error({ error }, 'Failed to start auto-refresh scheduler');
    }

    try {
      startGnulahdAutoSyncScheduler();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`WARN: No se pudo iniciar el programador de auto-sync GNULA - ${msg}\n`);
      logger.error({ error }, 'Failed to start gnulahd auto-sync scheduler');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`FATAL: Failed to start server - ${msg}\n`);
    const stack = error instanceof Error ? error.stack : '';
    if (stack) process.stderr.write(`${stack}\n`);
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

start();

export { buildServer };
