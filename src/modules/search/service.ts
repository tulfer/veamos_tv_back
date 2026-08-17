import { MediaItem, SearchResult, SyncMovie, SyncSeries } from '../../types';
import { fetchLiveChannels } from '../../providers/live-tv';
import { scrapeSearch } from '../../providers/search';
import { scrapePelisPediaSearch } from '../../providers/pelispedia';
import { searchGnulahd } from '../../providers/gnulahd';
import { upsertItemsByCol, loadSyncData } from '../../services/data-store';
import { memoryCache } from '../../cache/memory';
import { logger } from '../../utils/logger';

const PELIS_FALLBACK_THRESHOLD = 4;

async function searchSync(query: string): Promise<{ movies: MediaItem[]; series: MediaItem[] }> {
  const data = await loadSyncData();
  if (!data) return { movies: [], series: [] };

  const q = query.toLowerCase();
  const movies: MediaItem[] = data.movies
    .filter((m) => m.title.toLowerCase().includes(q))
    .slice(0, 20)
    .map((m) => ({ id: m.id, title: m.title, poster: m.poster, rating: m.rating, year: m.year, type: 'movie' }));

  const series: MediaItem[] = data.series
    .filter((s) => s.title.toLowerCase().includes(q))
    .slice(0, 20)
    .map((s) => ({ id: s.id, title: s.title, poster: s.poster, rating: s.rating, year: s.year, type: 'series' }));

  return { movies, series };
}

/** Los ítems de PelisPlus HD se guardan con id de catálogo v2 (gmov_/gser_) para
 *  que el content v2 los procese y persista. */
function toV2Id(item: MediaItem): MediaItem {
  if (item.id.startsWith('mov_')) return { ...item, id: item.id.replace(/^mov_/, 'gmov_') };
  if (item.id.startsWith('ser_')) return { ...item, id: item.id.replace(/^ser_/, 'gser_') };
  return item;
}

/** Guarda los resultados de PelisPlus en las colecciones de v2 para que el
 *  content service los encuentre sincronizados. */
async function persistExternalToV2(external: { movies: MediaItem[]; series: MediaItem[] }): Promise<void> {
  try {
    const existing = await loadSyncData();
    if (!existing) return;

    const moviesById = new Map((existing.gnulahdMovies || []).map((m) => [m.id, m]));
    const seriesById = new Map((existing.gnulahdSeries || []).map((s) => [s.id, s]));

    const newMovies: SyncMovie[] = [];
    const newSeries: SyncSeries[] = [];
    for (const item of external.movies) {
      if (!moviesById.has(item.id)) {
        newMovies.push({ id: item.id, title: item.title, poster: item.poster });
        moviesById.set(item.id, {} as SyncMovie);
      }
    }
    for (const item of external.series) {
      if (!seriesById.has(item.id)) {
        newSeries.push({ id: item.id, title: item.title, poster: item.poster, type: item.type === 'anime' ? 'anime' : undefined });
        seriesById.set(item.id, {} as SyncSeries);
      }
    }

    if (newMovies.length) await upsertItemsByCol<{ id: string }>('gnulahd-movies', newMovies);
    if (newSeries.length) await upsertItemsByCol<{ id: string }>('gnulahd-series', newSeries);
    if (newMovies.length || newSeries.length) {
      memoryCache.del('sync:data');
      logger.info({ movies: newMovies.length, series: newSeries.length }, 'Search persisted items into v2 collections');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to persist search results into v2 collections');
  }
}

function byTitle(items: MediaItem[]): (item: MediaItem) => boolean {
  const titles = new Set(items.map((item) => item.title.toLowerCase().trim()));
  return (item) => !titles.has(item.title.toLowerCase().trim());
}

/** Dedupe por id tras toV2Id: pelisplus/pelispedia/gnula comparten slugs y el
 *  mismo contenido puede llegar con títulos ligeramente distintos. */
function dedupeById<T extends MediaItem>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

export async function searchAll(query: string, page = 1): Promise<SearchResult> {
  const q = query.toLowerCase().trim();
  const cacheKey = `search:all:${q}`;
  const cached = memoryCache.get<SearchResult>(cacheKey);
  if (cached) return cached;

  const synced = await searchSync(query);
  const liveChannels = await fetchLiveChannels().catch(() => [] as any[]);
  const liveItems: MediaItem[] = liveChannels
    .filter((c: any) => c.title.toLowerCase().includes(q))
    .map((c: any) => ({ id: c.id, title: c.title, poster: c.logo, type: 'live' as const }));

  // 1) Buscar primero en PelisPlus HD.
  const pelis = await scrapeSearch(query);
  let externalMovies = pelis.movies.filter((em) => !synced.movies.some((sm) => sm.title.toLowerCase() === em.title.toLowerCase()));
  let externalSeries = pelis.series.filter((es) => !synced.series.some((ss) => ss.title.toLowerCase() === es.title.toLowerCase()));

  // 2) Si PelisPlus devuelve menos de 4 resultados, buscar en PelisPedia.
  if (pelis.movies.length + pelis.series.length < PELIS_FALLBACK_THRESHOLD) {
    const pelispedia = await scrapePelisPediaSearch(query);
    const ppMovies = pelispedia.movies
      .filter(byTitle(externalMovies))
      .filter((em) => !synced.movies.some((sm) => sm.title.toLowerCase() === em.title.toLowerCase()));
    const ppSeries = pelispedia.series
      .filter(byTitle(externalSeries))
      .filter((es) => !synced.series.some((ss) => ss.title.toLowerCase() === es.title.toLowerCase()));
    externalMovies = [...externalMovies, ...ppMovies];
    externalSeries = [...externalSeries, ...ppSeries];
  }

  // 3) Si aún hay menos de 4 resultados, completar con GNULA.
  if (externalMovies.length + externalSeries.length < PELIS_FALLBACK_THRESHOLD) {
    const gnula = await searchGnulahd(query);
    const gnulaMovies = gnula.items.filter((item) => item.type === 'movie');
    const gnulaSeries = gnula.items.filter((item) => item.type === 'series' || item.type === 'anime');
    externalMovies = [...externalMovies, ...gnulaMovies.filter(byTitle(externalMovies)).filter((item) => !synced.movies.some((sm) => sm.title.toLowerCase() === item.title.toLowerCase()))];
    externalSeries = [...externalSeries, ...gnulaSeries.filter(byTitle(externalSeries)).filter((item) => !synced.series.some((ss) => ss.title.toLowerCase() === item.title.toLowerCase()))];
  }

  // 4) Convertir a ids de catálogo v2 y guardarlos para que el content service los encuentre.
  externalMovies = dedupeById(externalMovies.map(toV2Id));
  externalSeries = dedupeById(externalSeries.map(toV2Id));

  if (externalMovies.length > 0 || externalSeries.length > 0) {
    await persistExternalToV2({ movies: externalMovies, series: externalSeries });
  }

  const allItems = [...synced.movies, ...externalMovies, ...synced.series, ...externalSeries, ...liveItems];

  const result: SearchResult = {
    items: allItems.slice(0, 20),
    total: allItems.length,
    query,
  };

  memoryCache.set(cacheKey, result, 120_000);
  return result;
}

export async function searchByType(
  query: string,
  type: 'movie' | 'series' | 'live',
  page = 1,
): Promise<SearchResult> {
  const q = query.toLowerCase().trim();

  if (type === 'live') {
    const channels = await fetchLiveChannels().catch(() => [] as any[]);
    const items: MediaItem[] = channels
      .filter((c: any) => c.title.toLowerCase().includes(q))
      .map((c: any) => ({ id: c.id, title: c.title, poster: c.logo, type: 'live' as const }));
    return { items: items.slice(0, 20), total: items.length, query };
  }

  const synced = await searchSync(query);
  let items = type === 'movie' ? synced.movies : synced.series;

  // 1) PelisPlus HD primero.
  const external = await scrapeSearch(query);
  let filtered = (type === 'movie' ? external.movies : external.series)
    .filter((em) => !items.some((sm) => sm.title.toLowerCase() === em.title.toLowerCase()));

  // 2) Si hay menos de 4 resultados en PelisPlus, buscar en PelisPedia.
  let sourceTotal = type === 'movie' ? external.movies.length : external.series.length;
  if (sourceTotal < PELIS_FALLBACK_THRESHOLD) {
    const pelispedia = await scrapePelisPediaSearch(query);
    const ppItems = (type === 'movie' ? pelispedia.movies : pelispedia.series)
      .filter(byTitle(filtered))
      .filter((em) => !items.some((sm) => sm.title.toLowerCase() === em.title.toLowerCase()));
    filtered = [...filtered, ...ppItems];
    sourceTotal += type === 'movie' ? pelispedia.movies.length : pelispedia.series.length;
  }

  // 3) Si aún hay menos de 4 resultados, completar con GNULA.
  if (sourceTotal < PELIS_FALLBACK_THRESHOLD) {
    const gnula = await searchGnulahd(query);
    const gnulaItems = type === 'movie'
      ? gnula.items.filter((item) => item.type === 'movie')
      : gnula.items.filter((item) => item.type === 'series' || item.type === 'anime');
    filtered = [...filtered, ...gnulaItems.filter(byTitle(filtered)).filter((item) => !items.some((sm) => sm.title.toLowerCase() === item.title.toLowerCase()))];
  }

  filtered = dedupeById(filtered.map(toV2Id));

  if (filtered.length > 0) {
    if (type === 'movie') await persistExternalToV2({ movies: filtered, series: [] });
    else await persistExternalToV2({ movies: [], series: filtered });
    items = [...items, ...filtered].slice(0, 20);
  }

  return { items: items.slice(0, 20), total: items.length, query };
}