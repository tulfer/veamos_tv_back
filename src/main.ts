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

  await app.register(sensible);

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(movieRoutes);
  await app.register(seriesRoutes);
  await app.register(liveTVRoutes);
  await app.register(searchRoutes);
  await app.register(homeRoutes);
  await app.register(contentRoutes);
  await app.register(syncRoutes);

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
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Veamos TV API started');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`FATAL: Failed to start server - ${msg}\n`);
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

start();

export { buildServer };
