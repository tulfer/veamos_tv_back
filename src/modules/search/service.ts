import { MediaItem, SearchResult, SyncMovie, SyncSeries } from '../../types';
import { fetchLiveChannels } from '../../providers/live-tv';
import { scrapeSearch } from '../../providers/search';
import { scrapePelisPediaSearch } from '../../providers/pelispedia';
import { upsertItemsByCol, loadSyncData } from '../../services/data-store';
import { memoryCache } from '../../cache/memory';
import { logger } from '../../utils/logger';

const PAGE_SIZE = 20;

/** Relevancia de un título frente a la consulta: 0 (nada) a 1000 (exacto). */
function relevanceScore(title: string, query: string): number {
  const t = normalize(title);
  const q = normalize(query);
  if (!t || !q) return 0;
  if (t === q) return 1000;
  let score = 0;
  if (t.startsWith(q)) score += 600;
  else if (t.includes(q)) score += 350;
  const qWords = q.split(/\s+/).filter(Boolean);
  if (qWords.length > 1) {
    const tWords = new Set(t.split(/\s+/).filter(Boolean));
    const matched = qWords.filter((word) => tWords.has(word)).length;
    score += Math.round((matched / qWords.length) * 300);
  }
  return score;
}

function byRelevance(query: string) {
  return (a: MediaItem, b: MediaItem): number => {
    const scoreA = relevanceScore(a.title, query);
    const scoreB = relevanceScore(b.title, query);
    if (scoreA !== scoreB) return scoreB - scoreA;
    if (a.title.length !== b.title.length) return a.title.length - b.title.length;
    const ratingA = a.rating || 0;
    const ratingB = b.rating || 0;
    if (ratingA !== ratingB) return ratingB - ratingA;
    return (b.year || 0) - (a.year || 0);
  };
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

async function searchSync(query: string): Promise<{ movies: MediaItem[]; series: MediaItem[] }> {
  const data = await loadSyncData();
  if (!data) return { movies: [], series: [] };

  const q = normalize(query);
  const pick = (
    items: Array<{ id: string; title: string; poster?: string; rating?: number; year?: number }>,
    type: 'movie' | 'series',
  ): MediaItem[] =>
    items
      .filter((item) => normalize(item.title).includes(q))
      // Se traen todos los que coinciden (acotados a 100) y el orden final lo
      // decide la relevancia, no el orden de la base.
      .slice(0, 100)
      .map((item) => ({ id: item.id, title: item.title, poster: item.poster, rating: item.rating, year: item.year, type }));

  return {
    movies: pick(data.movies, 'movie'),
    series: pick(data.series, 'series'),
  };
}

/** Los ítems de PelisPlus/PelisPedia se guardan con id de catálogo v2
 *  (gmov_/gser_) para que el content v2 los procese y persista. */
function toV2Id(item: MediaItem): MediaItem {
  if (item.id.startsWith('mov_')) return { ...item, id: item.id.replace(/^mov_/, 'gmov_') };
  if (item.id.startsWith('ser_')) return { ...item, id: item.id.replace(/^ser_/, 'gser_') };
  return item;
}

/** Guarda los resultados externos en las colecciones de v2 para que el
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

/** Mezcla resultados de los proveedores en orden de prioridad (GNULA,
 *  PelisPlus, PelisPedia) deduplicando por id (tras normalizar a v2) y por
 *  título exacto, de modo que el mismo contenido no aparezca duplicado. */
function mergeProviders(
  query: string,
  synced: MediaItem[],
  pelisPlus: MediaItem[],
  pelisPedia: MediaItem[],
): MediaItem[] {
  const byId = new Set<string>();
  const byTitle = new Set<string>();
  const merged: MediaItem[] = [];
  const add = (item: MediaItem, source: 'gnula' | 'pelisplus' | 'pelispedia') => {
    const key = normalize(item.title);
    if (byId.has(item.id) || byTitle.has(key)) return;
    byId.add(item.id);
    byTitle.add(key);
    merged.push({ ...item, source });
  };
  for (const item of synced) add(item, 'gnula');
  for (const item of pelisPlus) add(item, 'pelisplus');
  for (const item of pelisPedia) add(item, 'pelispedia');
  return merged.sort(byRelevance(query));
}

function paginate(items: MediaItem[], page: number, query: string): SearchResult {
  const start = (page - 1) * PAGE_SIZE;
  return {
    items: items.slice(start, start + PAGE_SIZE),
    total: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / PAGE_SIZE)),
    query,
  };
}

export async function searchAll(query: string, page = 1): Promise<SearchResult> {
  const q = normalize(query);
  const cacheKey = `search:all:${q}`;
  const cached = memoryCache.get<SearchResult>(cacheKey);
  if (cached) return cached;

  // Los 3 proveedores SIEMPRE: GNULA (catálogo sincronizado), PelisPlus HD y
  // PelisPedia; los resultados se mezclan y se ordenan de más a menos
  // coincidencia con la consulta.
  const [synced, pelis, pelispedia] = await Promise.all([
    searchSync(query),
    scrapeSearch(query),
    scrapePelisPediaSearch(query),
  ]);

  const contentItems = mergeProviders(
    query,
    [...synced.movies, ...synced.series],
    [...pelis.movies.map(toV2Id), ...pelis.series.map(toV2Id)],
    [...pelispedia.movies.map(toV2Id), ...pelispedia.series.map(toV2Id)],
  );

  const liveChannels = await fetchLiveChannels().catch(() => [] as any[]);
  const liveItems: MediaItem[] = liveChannels
    .filter((c: any) => normalize(c.title).includes(q))
    .slice(0, 20)
    .map((c: any) => ({ id: c.id, title: c.title, poster: c.logo, type: 'live' as const, source: 'live' as const }));

  const externalMovies = dedupeById([...pelis.movies, ...pelispedia.movies].map(toV2Id));
  const externalSeries = dedupeById([...pelis.series, ...pelispedia.series].map(toV2Id));
  if (externalMovies.length || externalSeries.length) {
    await persistExternalToV2({ movies: externalMovies, series: externalSeries });
  }

  const result = paginate([...contentItems, ...liveItems], page, query);
  memoryCache.set(cacheKey, result, 120_000);
  return result;
}

export async function searchByType(
  query: string,
  type: 'movie' | 'series' | 'live',
  page = 1,
): Promise<SearchResult> {
  const q = normalize(query);

  if (type === 'live') {
    const channels = await fetchLiveChannels().catch(() => [] as any[]);
    const items: MediaItem[] = channels
      .filter((c: any) => normalize(c.title).includes(q))
      .slice(0, 20)
      .map((c: any) => ({ id: c.id, title: c.title, poster: c.logo, type: 'live' as const, source: 'live' as const }));
    const result = paginate(items, page, query);
    return result;
  }

  const isMovie = type === 'movie';
  const [synced, pelis, pelispedia] = await Promise.all([
    searchSync(query),
    scrapeSearch(query),
    scrapePelisPediaSearch(query),
  ]);

  const syncedItems = isMovie ? synced.movies : synced.series;
  const pelisItems = (isMovie ? pelis.movies : pelis.series).map(toV2Id);
  const pelisPediaItems = (isMovie ? pelispedia.movies : pelispedia.series).map(toV2Id);

  const contentItems = mergeProviders(query, syncedItems, pelisItems, pelisPediaItems);

  const external = isMovie ? [...pelis.movies, ...pelispedia.movies] : [...pelis.series, ...pelispedia.series];
  const externalItems = dedupeById(external.map(toV2Id));
  if (externalItems.length) {
    await persistExternalToV2(isMovie ? { movies: externalItems, series: [] } : { movies: [], series: externalItems });
  }

  const result = paginate(contentItems, page, query);
  return result;
}

/** Dedupe por id tras toV2Id: pelisplus/pelispedia/gnula comparten slugs y el
 *  mismo contenido puede llegar con títulos ligeramente distintos. */
function dedupeById<T extends MediaItem>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}