import { MediaItem, SearchResult } from '../../types';
import { fetchLiveChannels } from '../../providers/live-tv';
import { memoryCache } from '../../cache/memory';
import { loadSyncData } from '../../services/data-store';

function filterByQuery(items: MediaItem[], query: string): MediaItem[] {
  const q = query.toLowerCase().trim();
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.genres?.some((g) => g.toLowerCase().includes(q)),
  );
}

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

  const allItems = [...synced.movies, ...synced.series, ...liveItems];

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
  const items = type === 'movie' ? synced.movies : synced.series;

  return { items: items.slice(0, 20), total: items.length, query };
}
