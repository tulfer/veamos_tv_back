import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
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
import { gnulahdRoutes } from './modules/gnulahd/routes';
import { syncRoutes } from './modules/sync/routes';
import { dbExplorerRoutes } from './modules/db-explorer/routes';
import { proxyRoutes } from './modules/proxy/routes';
import { playerRoutes } from './modules/player/routes';
import { startAutoRefreshScheduler } from './services/auto-refresh';
import { hydrateSyncState } from './services/sync-status';

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

    let syncHtml = '';
    try {
      const { getSyncStatus } = await import('./services/sync-status');
      const status = getSyncStatus();
      const fmt = (ts: number | null) => ts ? new Date(ts).toLocaleString('es-ES') : '—';
      const fmtDur = (ms: number | undefined) => {
        if (!ms) return '';
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        return `${Math.floor(s / 60)}m ${s % 60}s`;
      };
      const badge = (s: string) => {
        if (s === 'running') return '🔄 En curso';
        if (s === 'completed') return '✅ Completada';
        if (s === 'failed') return '❌ Fallida';
        return '⏸️ Pendiente';
      };
      const syncRow = (label: string, st: any) => `
<div class="sync-item">
  <span class="sync-label">${label}</span>
  <span class="sync-badge">${badge(st.status)}</span>
  <span class="sync-count">${st.count != null ? `${st.count}` : ''}</span>
  <span class="sync-dur">${fmtDur(st.duration)}</span>
  <span class="sync-date">${fmt(st.lastRun)}</span>
  ${st.error ? `<span class="sync-err" title="${st.error}">⚠️</span>` : ''}
</div>`;
      syncHtml = `
<div class="sync-section">
  <h3>Estado de Sincronización</h3>
  <div class="sync-header">
    <span class="sync-label">Tipo</span>
    <span class="sync-badge">Estado</span>
    <span class="sync-count">Items</span>
    <span class="sync-dur">Duración</span>
    <span class="sync-date">Última ejecución</span>
  </div>
  <div class="sync-grid">
    ${syncRow('Películas', status.movies)}
    ${syncRow('Series', status.series)}
    ${syncRow('Canales', status.channels)}
    ${syncRow('Estrenos Películas', status.estrenoMovies)}
    ${syncRow('Estrenos Series', status.estrenoSeries)}
    ${syncRow('Populares Películas', status.popularMovies)}
    ${syncRow('Populares Series', status.popularSeries)}
    ${syncRow('Home', status.home)}
    ${syncRow('Home GNULA', status.gnulahdHome)}
    ${syncRow('GNULA Películas', status.gnulahdMovies)}
    ${syncRow('GNULA Series', status.gnulahdSeries)}
    ${syncRow('GNULA Anime', status.gnulahdAnime)}
  </div>
</div>`;
    } catch (syncError) {
      process.stderr.write(`Sync status section failed: ${(syncError as Error)?.message}\n`);
    }

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
.container{text-align:center;padding:2rem;width:100%;max-width:800px}
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
.sync-section{margin-top:2rem;background:rgba(255,255,255,.05);border-radius:16px;padding:1.5rem;
  backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1)}
.sync-section h3{font-size:1.1rem;font-weight:600;margin-bottom:1rem;color:#a0a0c0}
.sync-grid{display:flex;flex-direction:column;gap:.5rem}
.sync-header{display:flex;padding:.4rem .8rem;font-size:.75rem;color:#8080a0;font-weight:600}
.sync-item{display:flex;justify-content:space-between;align-items:center;padding:.4rem .8rem;
  background:rgba(255,255,255,.03);border-radius:8px;font-size:.85rem}
.sync-label{font-weight:500;text-align:left;flex:2}
.sync-badge{text-align:center;flex:0 0 110px}
.sync-count{text-align:center;flex:0 0 50px;font-size:.8rem;color:#a0a0c0}
.sync-dur{text-align:center;flex:0 0 60px;font-size:.8rem;color:#a0a0c0}
.sync-date{text-align:right;flex:0 0 160px;font-size:.8rem;color:#8080a0}
.sync-err{cursor:help;margin-left:.3rem}
.footer{margin-top:2rem;font-size:.85rem;color:#606080}
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
${syncHtml}
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
    process.stderr.write('start: verificando tabla store (Supabase)...\n');
    await ensureStoreTable();

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
