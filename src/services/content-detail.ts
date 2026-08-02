import { ContentDetail, SyncMovie, SyncSeries } from '../types';
import { loadSyncData, upsertItemByCol } from './data-store';
import { scrapeMovieDetail } from '../providers/movies';
import { scrapeSeriesDetail } from '../providers/series';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { env } from '../config/env';
import { buildProxyUrl } from '../utils/proxy-url';
import { isNetuHost } from './netu-resolver';

/**
 * Detalles de contenido con "enriquecimiento en lectura":
 * si la entrada sincronizada no tiene videos (porque el detalle falló en el
 * momento del sync y se guardó el item básico), se escrapea en vivo y se
 * devuelve el detalle real. Si el scrape da videos, se guarda de vuelta en
 * Firestore para curar la base (self-healing on read).
 */

const netuProxyBase = env.FALLBACK_EXTRACT_URL || env.PUBLIC_BASE_URL || '';

/**
 * Los servidores "netu" no son reproducibles directamente por la app:
 * - las páginas embed (waaw.to/f/...) son JS-driven y no tienen m3u8 estático
 * - las URLs HLS (cfglobalcdn) llevan token por IP + expiración
 * Se devuelven proxyficadas hacia Cloud Run (que tiene Playwright y resuelve
 * con la misma IP desde la que descarga). En App Hosting esto también apunta
 * a Cloud Run vía FALLBACK_EXTRACT_URL.
 */
function proxyNetuVideoUrls(videos?: ContentDetail['videos']): void {
  videos?.forEach((video) => {
    video.servers?.forEach((server) => {
      if (server.name?.toLowerCase() === 'netu' && isNetuHost(server.url)) {
        server.url = new URL(
          buildProxyUrl(server.url, new URL(server.url).origin),
          netuProxyBase,
        ).toString();
      }
    });
  });
}

export function proxyNetuServers(detail: ContentDetail): ContentDetail {
  if (!netuProxyBase) return detail;
  proxyNetuVideoUrls(detail.videos);
  detail.seasons?.forEach((season) => {
    season.episodes?.forEach((episode) => proxyNetuVideoUrls(episode.videos));
  });
  return detail;
}

function mapMovie(movie: SyncMovie): ContentDetail {
  return {
    id: movie.id,
    title: movie.title,
    description: movie.description || `${movie.title} disponible en Veamos TV.`,
    poster: movie.poster,
    backdrop: movie.backdrop || movie.poster,
    rating: movie.rating || 7.0,
    year: movie.year || 2024,
    duration: movie.duration,
    genres: movie.genres || ['Acción', 'Drama'],
    cast: movie.cast || [{ name: 'Reparto Principal' }],
    type: 'movie',
    videos: movie.videos,
  };
}

function mapSeries(series: SyncSeries): ContentDetail {
  return {
    id: series.id,
    title: series.title,
    description: series.description || `${series.title} disponible en Veamos TV.`,
    poster: series.poster,
    backdrop: series.backdrop || series.poster,
    rating: series.rating || 8.0,
    year: series.year || 2024,
    genres: series.genres || ['Drama', 'Action'],
    cast: series.cast || [{ name: 'Reparto Principal' }],
    type: 'series',
    seasons: series.seasons,
    videos: series.videos,
  };
}

async function healDetail(collection: 'movies' | 'series', detail: ContentDetail): Promise<void> {
  try {
    const { id, ...clean } = JSON.parse(JSON.stringify(detail)) as { id: string } & Record<string, unknown>;
    await upsertItemByCol<{ id: string } & Record<string, unknown>>(collection, { id, ...clean });
    memoryCache.del('sync:data');
    logger.info({ id: detail.id, col: collection }, 'Detalle enriquecido guardado en la base');
  } catch (error) {
    logger.warn({ error: (error as Error).message, id: detail.id }, 'No se pudo guardar detalle enriquecido');
  }
}

export async function getMovieDetailContent(id: string): Promise<ContentDetail | null> {
  const synced = await loadSyncData();
  const movie = synced?.movies.find((m) => m.id === id);

  if (movie && movie.videos && movie.videos.length > 0) {
    return mapMovie(movie);
  }

  const scraped = await scrapeMovieDetail(id);
  if (scraped) {
    if (scraped.videos && scraped.videos.length > 0) {
      await healDetail('movies', scraped);
    }
    return scraped;
  }
  return movie ? mapMovie(movie) : null;
}

export async function getSeriesDetailContent(id: string): Promise<ContentDetail | null> {
  const synced = await loadSyncData();
  const series = synced?.series.find((s) => s.id === id);

  if (series && series.seasons && series.seasons.length > 0) {
    return mapSeries(series);
  }

  const scraped = await scrapeSeriesDetail(id);
  if (scraped) {
    if (scraped.seasons && scraped.seasons.length > 0) {
      await healDetail('series', scraped);
    }
    return scraped;
  }
  return series ? mapSeries(series) : null;
}
