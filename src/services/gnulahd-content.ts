import { ContentDetail, SyncMovie, SyncSeries } from '../types';
import { loadSyncData, upsertItemByCol, upsertItemsByCol } from './data-store';
import { scrapeGnulahdDetail } from '../providers/gnulahd';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';

/**
 * Detalle de contenido de GNULA HD con "enriquecimiento en lectura"
 * (mismo patrón que content-detail.ts pero con colecciones propias):
 * si la entrada sincronizada no tiene videos/temporadas, se escrapea en vivo
 * y se cura la base si el scrape trae player.
 */

type GnulahdCollection = 'gnulahd-movies' | 'gnulahd-series' | 'gnulahd-anime';

function collectionForDetail(detail: ContentDetail): GnulahdCollection {
  if (detail.id.startsWith('gmov_')) return 'gnulahd-movies';
  if (detail.id.startsWith('gani_')) return 'gnulahd-anime';
  return 'gnulahd-series';
}

function collectionFor(id: string): GnulahdCollection | null {
  if (id.startsWith('gmov_')) return 'gnulahd-movies';
  if (id.startsWith('gser_')) return 'gnulahd-series';
  if (id.startsWith('gani_')) return 'gnulahd-anime';
  return null;
}

function mapGnulahdMovie(movie: SyncMovie): ContentDetail {
  if (movie.content) return movie.content;
  return {
    id: movie.id,
    title: movie.title,
    description: movie.description || `${movie.title} disponible en Veamos TV.`,
    poster: movie.poster,
    backdrop: movie.backdrop || movie.poster,
    rating: movie.rating || 7.0,
    year: movie.year || 2024,
    duration: movie.duration,
    country: movie.country,
    genres: movie.genres || ['Acción', 'Drama'],
    cast: movie.cast || [{ name: 'Reparto Principal' }],
    type: 'movie',
    videos: movie.videos,
    downloads: movie.downloads,
  };
}

function mapGnulahdSeries(series: SyncSeries): ContentDetail {
  if (series.content) return series.content;
  return {
    id: series.id,
    title: series.title,
    description: series.description || `${series.title} disponible en Veamos TV.`,
    poster: series.poster,
    backdrop: series.backdrop || series.poster,
    rating: series.rating || 8.0,
    year: series.year || 2024,
    country: series.country,
    genres: series.genres || ['Drama', 'Action'],
    cast: series.cast || [{ name: 'Reparto Principal' }],
    type: 'series',
    seasons: series.seasons,
    videos: series.videos,
    downloads: series.downloads,
  };
}

async function healGnulahd(collection: GnulahdCollection, detail: ContentDetail): Promise<void> {
  try {
    const { id, ...clean } = JSON.parse(JSON.stringify(detail)) as { id: string } & Record<string, unknown>;
    await upsertItemByCol<{ id: string } & Record<string, unknown>>(collection, { id, content: detail, ...clean });
    memoryCache.del('sync:data');
    logger.info({ id: detail.id, col: collection }, 'Detalle GNULA enriquecido guardado en la base');
  } catch (error) {
    logger.warn({ error: (error as Error).message, id: detail.id }, 'No se pudo guardar detalle enriquecido GNULA');
  }
}

/** Obtiene y guarda el detalle de una lista de ítems sin abortar el sync si
 * algún detalle individual falla. */
export async function prefetchGnulahdDetails(ids: string[]): Promise<number> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  const details: ContentDetail[] = [];
  for (let i = 0; i < uniqueIds.length; i += 5) {
    const batch = uniqueIds.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map((id) => scrapeGnulahdDetail(id)));
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) details.push(result.value);
    }
  }

  const grouped = new Map<GnulahdCollection, ContentDetail[]>();
  for (const detail of details) {
    const collection = collectionForDetail(detail);
    const group = grouped.get(collection) || [];
    group.push(detail);
    grouped.set(collection, group);
  }
  for (const [collection, collectionDetails] of grouped) {
    const items = collectionDetails.map((detail) => ({
      id: detail.id,
      content: detail,
      ...detail,
    }));
    await upsertItemsByCol(collection, items);
  }
  memoryCache.del('sync:data');
  return details.length;
}

export async function getGnulahdDetailContent(id: string): Promise<ContentDetail | null> {
  const collection = collectionFor(id);
  if (!collection) return null;

  const synced = await loadSyncData();
  const isSeriesCol = collection !== 'gnulahd-movies';

  const item: SyncMovie | SyncSeries | undefined = isSeriesCol
    ? (collection === 'gnulahd-series' ? synced?.gnulahdSeries : synced?.gnulahdAnime)?.find((s) => s.id === id)
    : synced?.gnulahdMovies?.find((m) => m.id === id);

  const isComplete = isSeriesCol
    ? !!((item as SyncSeries | undefined)?.seasons?.length)
    : !!((item as SyncMovie | undefined)?.videos?.length);

  if (item && item.content) {
    return isSeriesCol ? mapGnulahdSeries(item as SyncSeries) : mapGnulahdMovie(item as SyncMovie);
  }

  if (item && isComplete) {
    return isSeriesCol ? mapGnulahdSeries(item as SyncSeries) : mapGnulahdMovie(item as SyncMovie);
  }

  const scraped = await scrapeGnulahdDetail(id);
  if (scraped) {
    const scrapedComplete = isSeriesCol ? !!scraped.seasons?.length : !!scraped.videos?.length;
    if (scrapedComplete) {
      await healGnulahd(collection, scraped);
    }
    return scraped;
  }
  return item ? (isSeriesCol ? mapGnulahdSeries(item as SyncSeries) : mapGnulahdMovie(item as SyncMovie)) : null;
}
