import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { env } from './config/env';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/error';

import { authRoutes } from './modules/auth/routes';
import { userRoutes } from './modules/users/routes';
import { movieRoutes } from './modules/movies/routes';
import { seriesRoutes } from './modules/series/routes';
import { liveTVRoutes } from './modules/live-tv/routes';
import { searchRoutes } from './modules/search/routes';
import { homeRoutes } from './modules/home/routes';
import { contentRoutes } from './modules/content/routes';
import { syncRoutes } from './modules/sync/routes';

process.on('uncaughtException', (err) => {
  process.stderr.write(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}\n`);
});
process.on('unhandledRejection', (err: any) => {
  process.stderr.write(`UNHANDLED REJECTION: ${err?.message || err}\n`);
});

async function buildServer() {
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
  });

  app.setErrorHandler(errorHandler);

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  try {
    await app.register(sensible);
  } catch (e) {
    process.stderr.write(`Warning: sensible plugin failed to register: ${e}\n`);
  }

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(movieRoutes);
  await app.register(seriesRoutes);
  await app.register(liveTVRoutes);
  await app.register(searchRoutes);
  await app.register(homeRoutes);
  await app.register(contentRoutes);
  await app.register(syncRoutes);

  app.get('/', async () => ({ status: 'ok', service: 'veamos-tv-api' }));
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
    const app = await buildServer();
    const port = parseInt(process.env.PORT || '8080', 10);
    const host = process.env.HOST || '0.0.0.0';
    process.stderr.write(`Starting server on ${host}:${port}...\n`);
    await app.listen({ port, host });
    process.stderr.write(`Server listening on ${host}:${port}\n`);
    logger.info({ port, host, env: env.NODE_ENV }, 'Veamos TV API started');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`FATAL: Failed to start server - ${msg}\n`);
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

start();

export { buildServer };
