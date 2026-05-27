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

  app.get('/', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Veamos TV</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);
  min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff}
.container{text-align:center;padding:2rem}
.logo{font-size:4rem;font-weight:800;background:linear-gradient(135deg,#667eea,#764ba2);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1rem}
.tagline{font-size:1.3rem;color:#a0a0c0;margin-bottom:2.5rem}
.download-btn{display:inline-block;padding:1rem 2.5rem;border-radius:50px;
  background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;text-decoration:none;
  font-size:1.1rem;font-weight:600;transition:transform .2s,box-shadow .2s;
  box-shadow:0 4px 20px rgba(102,126,234,.4)}
.download-btn:hover{transform:translateY(-2px);box-shadow:0 6px 25px rgba(102,126,234,.6)}
.features{display:flex;gap:2rem;margin-top:3rem;flex-wrap:wrap;justify-content:center}
.feature{background:rgba(255,255,255,.05);border-radius:16px;padding:1.5rem;width:180px;
  backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1)}
.feature-icon{font-size:2rem;margin-bottom:.5rem}
.feature-title{font-weight:600;margin-bottom:.3rem}
.feature-desc{font-size:.85rem;color:#a0a0c0}
.footer{margin-top:3rem;font-size:.85rem;color:#606080}
</style>
</head>
<body>
<div class="container">
<div class="logo">Veamos TV</div>
<p class="tagline">Tu plataforma de entretenimiento</p>
<a class="download-btn" href="#">Descargar la app Veamos TV</a>
<div class="features">
<div class="feature"><div class="feature-icon">📺</div>
<div class="feature-title">TV en Vivo</div>
<div class="feature-desc">Canales en tiempo real</div></div>
<div class="feature"><div class="feature-icon">🎬</div>
<div class="feature-title">Películas</div>
<div class="feature-desc">Estrenos y clásicos</div></div>
<div class="feature"><div class="feature-icon">📡</div>
<div class="feature-title">Series</div>
<div class="feature-desc">Temporadas completas</div></div>
</div>
<div class="footer">Veamos TV &copy; 2026</div>
</div>
</body>
</html>`;
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
