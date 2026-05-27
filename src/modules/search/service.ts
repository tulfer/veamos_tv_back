import { MediaItem, SearchResult, SyncData } from '../../types';
import { fetchLiveChannels } from '../../providers/live-tv';
import { scrapeSearch } from '../../providers/search';
import { memoryCache } from '../../cache/memory';
import { loadSyncData, saveSyncData } from '../../services/data-store';
import { logger } from '../../utils/logger';

function searchSync(query: string): { movies: MediaItem[]; series: MediaItem[] } {
  const data = loadSyncData();
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

function persistExternalResults(external: { movies: MediaItem[]; series: MediaItem[] }): void {
  try {
    const existing = loadSyncData();
    if (!existing) return;

    const movieTitles = new Set(existing.movies.map((m) => m.title.toLowerCase().trim()));
    const seriesTitles = new Set(existing.series.map((s) => s.title.toLowerCase().trim()));
    const updated: SyncData = {
      movies: [...existing.movies],
      series: [...existing.series],
      channels: existing.channels || [],
      popularMovies: existing.popularMovies || [],
      popularSeries: existing.popularSeries || [],
      estrenoMovies: existing.estrenoMovies || [],
      estrenoSeries: existing.estrenoSeries || [],
      updatedAt: Date.now(),
    };

    for (const item of external.movies) {
      if (!movieTitles.has(item.title.toLowerCase().trim())) {
        updated.movies.push({
          id: item.id,
          title: item.title,
          poster: item.poster,
        });
        movieTitles.add(item.title.toLowerCase().trim());
      }
    }

    for (const item of external.series) {
      if (!seriesTitles.has(item.title.toLowerCase().trim())) {
        updated.series.push({
          id: item.id,
          title: item.title,
          poster: item.poster,
        });
        seriesTitles.add(item.title.toLowerCase().trim());
      }
    }

    if (updated.movies.length !== existing.movies.length || updated.series.length !== existing.series.length) {
      saveSyncData(updated);
      logger.info({ movies: updated.movies.length - existing.movies.length, series: updated.series.length - existing.series.length }, 'Search persisted new items');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to persist search results');
  }
}

export async function searchAll(query: string, page = 1): Promise<SearchResult> {
  const q = query.toLowerCase().trim();
  const cacheKey = `search:all:${q}`;
  const cached = memoryCache.get<SearchResult>(cacheKey);
  if (cached) return cached;

  const synced = searchSync(query);
  const liveChannels = await fetchLiveChannels().catch(() => [] as any[]);
  const liveItems: MediaItem[] = liveChannels
    .filter((c: any) => c.title.toLowerCase().includes(q))
    .map((c: any) => ({ id: c.id, title: c.title, poster: c.logo, type: 'live' as const }));

  let externalMovies: MediaItem[] = [];
  let externalSeries: MediaItem[] = [];
  if (synced.movies.length + synced.series.length < 20) {
    const external = await scrapeSearch(query);
    externalMovies = external.movies.filter((em) => !synced.movies.some((sm) => sm.title.toLowerCase() === em.title.toLowerCase()));
    externalSeries = external.series.filter((es) => !synced.series.some((ss) => ss.title.toLowerCase() === es.title.toLowerCase()));
    if (externalMovies.length > 0 || externalSeries.length > 0) {
      persistExternalResults({ movies: externalMovies, series: externalSeries });
    }
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

  const synced = searchSync(query);
  let items = type === 'movie' ? synced.movies : synced.series;

  if (items.length < 20) {
    const external = await scrapeSearch(query);
    const filtered = (type === 'movie' ? external.movies : external.series)
      .filter((em) => !items.some((sm) => sm.title.toLowerCase() === em.title.toLowerCase()));
    if (filtered.length > 0) {
      if (type === 'movie') persistExternalResults({ movies: filtered, series: [] });
      else persistExternalResults({ movies: [], series: filtered });
    }
    items = [...items, ...filtered].slice(0, 20);
  }

  return { items: items.slice(0, 20), total: items.length, query };
}
