import { ContentDetail, SyncMovie, SyncSeries, Episode, VideoLanguage, Season } from '../types';
import { loadSyncData, upsertItemByCol, upsertItemsByCol } from './data-store';
import { scrapeGnulahdDetail } from '../providers/gnulahd';
import { scrapeMovieDetail } from '../providers/movies';
import { scrapeSeriesDetail } from '../providers/series';
import { scrapePelisPediaMovieDetail, scrapePelisPediaSeriesDetail } from '../providers/pelispedia';
import { scrapeJkanimeDetail } from '../providers/jkanime';
import { scrapeLatanimeDetail } from '../providers/latanime';
import { unwrapDetailProxy } from './content-detail';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { pushLog } from './sync-status';

/**
 * Detalle de contenido de GNULA HD con "enriquecimiento en lectura"
 * (mismo patrón que content-detail.ts pero con colecciones propias):
 * si la entrada sincronizada no tiene videos/temporadas, se escrapea en vivo
 * y se cura la base si el scrape trae player.
 */

type GnulahdCollection = 'gnulahd-movies' | 'gnulahd-series' | 'gnulahd-anime';
type GnulahdLogType = 'gnulahdHome' | 'gnulahdMovies' | 'gnulahdSeries' | 'gnulahdAnime' | 'gnulahdItem';

/** Los contenidos cacheados más viejos que esto se re-resuelven para
 *  refrescar capítulos (TTL de 24h). */
export const CONTENT_TTL_MS = 24 * 60 * 60 * 1000;

/** ¿El content de un ítem se considera vigente según su contentUpdatedAt?
 *  Las filas sin timestamp se tratan como vencidas (se re-resuelven una vez
 *  y el heal les escribe el timestamp). */
export function isContentFresh(updatedAt?: number): boolean {
  return typeof updatedAt === 'number' && Date.now() - updatedAt < CONTENT_TTL_MS;
}

function serverCount(videos?: VideoLanguage[]): number {
  return videos?.reduce((total, language) => total + (language.servers?.length || 0), 0) || 0;
}

function hasFewerThanTwoServersPerLanguage(videos?: VideoLanguage[]): boolean {
  return !videos?.length || videos.some((language) => (language.servers?.length || 0) < 2);
}

function hasFewerThanThreeServersPerLanguage(videos?: VideoLanguage[]): boolean {
  return !videos?.length || videos.some((language) => (language.servers?.length || 0) < 3);
}

function mergeVideoLanguages(primary: VideoLanguage[] | undefined, extra: VideoLanguage[] | undefined): VideoLanguage[] | undefined {
  if (!extra?.length) return primary;
  const result = (primary || []).map((language) => ({ ...language, servers: [...language.servers] }));
  for (const language of extra) {
    const existing = result.find((item) => item.language.toLowerCase() === language.language.toLowerCase());
    if (!existing) {
      result.push({ ...language, servers: [...language.servers] });
      continue;
    }
    const urls = new Set(existing.servers.map((server) => server.url));
    for (const server of language.servers) {
      if (!urls.has(server.url)) {
        existing.servers.push(server);
        urls.add(server.url);
      }
    }
  }
  return result;
}

function mergeEpisodeVideos(primary: Episode, extra: Episode, force = false): void {
  if (!force && !hasFewerThanTwoServersPerLanguage(primary.videos)) return;
  const merged = mergeVideoLanguages(primary.videos, extra.videos);
  if (merged?.length) primary.videos = merged;
}

/** Mezcla temporadas de anime: la base es JKAnime (subtitulado, suele tener
 *  más episodios) y a cada episodio se le agregan los servidores en latino de
 *  Latanime si existen, sin recortar la lista de episodios. */
function mergeAnimeSources(subtitled: Season[] | undefined, latino: Season[] | undefined): Season[] | null {
  const base = subtitled?.length ? subtitled : latino?.length ? latino : null;
  if (!base) return null;
  const latinoEpisodes = latino?.flatMap((season) => season.episodes) || [];
  return base.map((season) => ({
    ...season,
    episodes: season.episodes.map((episode) => {
      const extra = latinoEpisodes.find((item) => item.episode_number === episode.episode_number);
      if (!extra?.videos?.length) return episode;
      const videos = [...(episode.videos || [])];
      for (const language of extra.videos) {
        if (videos.some((item) => item.language.toLowerCase() === language.language.toLowerCase())) continue;
        videos.push({ ...language, servers: [...language.servers] });
      }
      return { ...episode, videos };
    }),
  }));
}

/** Completa un detalle V2 con servidores PelisPlus cuando V2 solo tiene uno. */
export async function enrichGnulahdDetail(detail: ContentDetail, logType: GnulahdLogType): Promise<ContentDetail> {
  unwrapDetailProxy(detail);
  const slug = detail.id.replace(/^g(?:mov|ser|ani)_/, '');
  if (!slug) return detail;

  if (detail.type === 'movie' && hasFewerThanTwoServersPerLanguage(detail.videos)) {
    const extra = await scrapeMovieDetail(`mov_${slug}`);
    if (extra && serverCount(extra.videos) > 0) {
      detail.videos = mergeVideoLanguages(detail.videos, extra.videos);
    }
    if (hasFewerThanTwoServersPerLanguage(detail.videos)) {
      pushLog(logType, `PelisPlus sin videos suficientes, consultando PelisPedia para ${slug}...`);
      const pelispedia = await scrapePelisPediaMovieDetail(`mov_${slug}`);
      if (pelispedia && serverCount(pelispedia.videos) > 0) {
        detail.videos = mergeVideoLanguages(detail.videos, pelispedia.videos);
        pushLog(logType, `PelisPedia agregó servidores de ${slug}`);
      } else {
        pushLog(logType, `PelisPedia no devolvió servidores para ${slug}`);
      }
    }
  }

  const needsSeriesEnrichment = detail.seasons?.some((season) => season.episodes.some((episode) => hasFewerThanTwoServersPerLanguage(episode.videos)));
  if (detail.type === 'series' && needsSeriesEnrichment && detail.seasons?.length) {
    const extra = await scrapeSeriesDetail(`ser_${slug}`);
    if (extra?.seasons?.length) {
      for (const season of detail.seasons) {
        const extraSeason = extra.seasons.find((item) => item.season_number === season.season_number);
        if (!extraSeason) continue;
        for (const episode of season.episodes) {
          const extraEpisode = extraSeason.episodes.find((item) => item.episode_number === episode.episode_number);
          if (extraEpisode) mergeEpisodeVideos(episode, extraEpisode);
        }
      }
    }
    const stillNeedsSeries = detail.seasons?.some((season) => season.episodes.some((episode) => hasFewerThanTwoServersPerLanguage(episode.videos)));
    if (stillNeedsSeries) {
      pushLog(logType, `PelisPlus sin videos suficientes, consultando PelisPedia para ${slug}...`);
      const pelispedia = await scrapePelisPediaSeriesDetail(`ser_${slug}`);
      if (pelispedia?.seasons?.length) {
        for (const season of detail.seasons) {
          const extraSeason = pelispedia.seasons.find((item) => item.season_number === season.season_number) || pelispedia.seasons[0];
          for (const episode of season.episodes) {
            const extraEpisode = extraSeason.episodes.find((item) => item.episode_number === episode.episode_number);
            if (extraEpisode) mergeEpisodeVideos(episode, extraEpisode);
          }
        }
        pushLog(logType, `PelisPedia agregó servidores a ${slug}`);
      } else {
        pushLog(logType, `PelisPedia no devolvió temporadas para ${slug}`);
      }
    }
  }
  const needsAnimeEnrichment = detail.seasons?.some((season) => season.episodes.some((episode) => hasFewerThanThreeServersPerLanguage(episode.videos)));
  if (detail.type === 'anime' && needsAnimeEnrichment && detail.seasons?.length) {
    // JKAnime (subtitulado) y Latanime (latino): el subtitulado suele tener más
    // episodios, así que se mezclan los servidores latino en los episodios que
    // los tengan sin recortar la lista de episodios.
    pushLog(logType, `Consultando JKAnime para ${slug}...`);
    const jkanime = await scrapeJkanimeDetail(slug, (message) => pushLog(logType, message));
    const latanime = await scrapeLatanimeDetail(slug, (message) => pushLog(logType, message), undefined, detail.title);
    if (jkanime?.seasons?.length) {
      const episodes = jkanime.seasons.reduce((total, season) => total + season.episodes.length, 0);
      const servers = jkanime.seasons.reduce((total, season) => total + season.episodes.reduce((count, episode) => count + serverCount(episode.videos), 0), 0);
      pushLog(logType, `JKAnime devolvió ${episodes} episodios y ${servers} servidores para ${slug}`);
    } else {
      pushLog(logType, `JKAnime no devolvió servidores para ${slug}`);
    }
    if (latanime?.seasons?.length) {
      const episodes = latanime.seasons.reduce((total, season) => total + season.episodes.length, 0);
      const servers = latanime.seasons.reduce((total, season) => total + season.episodes.reduce((count, episode) => count + serverCount(episode.videos), 0), 0);
      pushLog(logType, `Latanime devolvió ${episodes} episodios y ${servers} servidores para ${slug}`);
    } else {
      pushLog(logType, `Latanime no devolvió servidores para ${slug}`);
    }
    const mergedSeasons = mergeAnimeSources(jkanime?.seasons, latanime?.seasons);
    if (mergedSeasons) {
      detail.seasons = mergedSeasons;
    } else if (jkanime?.seasons?.length) {
      detail.seasons = jkanime.seasons;
    }
  }
  return detail;
}

function collectionForDetail(detail: ContentDetail): GnulahdCollection {
  if (detail.id.startsWith('gmov_') || detail.id.startsWith('mov_')) return 'gnulahd-movies';
  if (detail.id.startsWith('gani_')) return 'gnulahd-anime';
  return 'gnulahd-series';
}

function collectionFor(id: string): GnulahdCollection | null {
  if (id.startsWith('gmov_') || id.startsWith('mov_')) return 'gnulahd-movies';
  if (id.startsWith('gser_') || id.startsWith('ser_')) return 'gnulahd-series';
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
    type: series.id.startsWith('gani_') || series.type === 'anime' ? 'anime' : 'series',
    seasons: series.seasons,
    videos: series.videos,
    downloads: series.downloads,
  };
}

async function healGnulahd(collection: GnulahdCollection, detail: ContentDetail, source?: string): Promise<void> {
  try {
    const { id, ...clean } = JSON.parse(JSON.stringify(detail)) as { id: string } & Record<string, unknown>;
    await upsertItemByCol<{ id: string } & Record<string, unknown>>(collection, {
      id,
      content: detail,
      contentUpdatedAt: Date.now(),
      ...clean,
      ...(source ? { source } : {}),
    });
    memoryCache.del('sync:data');
    logger.info({ id: detail.id, col: collection }, 'Detalle GNULA enriquecido guardado en la base');
  } catch (error) {
    logger.warn({ error: (error as Error).message, id: detail.id }, 'No se pudo guardar detalle enriquecido GNULA');
  }
}

/** Obtiene y guarda el detalle de una lista de ítems sin abortar el sync si
 * algún detalle individual falla. */
export async function prefetchGnulahdDetails(
  ids: string[],
  onProgress?: (completed: number, total: number, saved: number) => void,
  logType: GnulahdLogType = 'gnulahdAnime',
): Promise<number> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  const details: ContentDetail[] = [];
  const failedIds: string[] = [];
  let savedDetails = 0;
  for (let i = 0; i < uniqueIds.length; i += 5) {
    const batch = uniqueIds.slice(i, i + 5);
    let completedInBatch = 0;
    const results = await Promise.allSettled(batch.map(async (id) => {
      try {
        const detail = await scrapeGnulahdDetail(id);
        return detail ? await enrichGnulahdDetail(detail, logType) : detail;
      } finally {
        completedInBatch++;
        onProgress?.(Math.min(i + completedInBatch, uniqueIds.length), uniqueIds.length, savedDetails);
      }
    }));
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        details.push(result.value);
        try {
          await persistGnulahdDetails([result.value]);
          savedDetails++;
        } catch (error) {
          logger.warn({ error, id: result.value.id }, 'No se pudo guardar detalle GNULA; el sync continuarÃ¡');
        }
      } else if (result.status === 'fulfilled') {
        failedIds.push(batch[results.indexOf(result)]);
      } else {
        failedIds.push(batch[results.indexOf(result)]);
      }
    }
    onProgress?.(Math.min(i + batch.length, uniqueIds.length), uniqueIds.length, savedDetails);
  }

  memoryCache.del('sync:data');
  if (failedIds.length > 0) {
    pushLog(logType, `Fallaron ${failedIds.length} detalles: ${failedIds.join(', ')}`);
  } else {
    pushLog(logType, 'Todos los detalles fueron procesados correctamente.');
  }
  return savedDetails;
}

async function persistGnulahdDetails(details: ContentDetail[]): Promise<void> {
  const grouped = new Map<GnulahdCollection, ContentDetail[]>();
  for (const detail of details) {
    const collection = collectionForDetail(detail);
    const group = grouped.get(collection) || [];
    group.push(detail);
    grouped.set(collection, group);
  }
  for (const [collection, collectionDetails] of grouped) {
    await upsertItemsByCol(collection, collectionDetails.map((detail) => ({
      id: detail.id,
      content: detail,
      contentUpdatedAt: Date.now(),
      ...detail,
    })));
  }
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** ¿El contenido corresponde al ítem del catálogo? Un slug corto en GNULA
 *  puede resolver a otro título (ej: "You" → "You and I Are Polar Opposites"),
 *  así que el título cacheado debe coincidir con el del catálogo. */
function titlesMatchExact(a: string, b: string): boolean {
  return normalizeTitle(a) === normalizeTitle(b);
}

export async function getGnulahdDetailContent(id: string): Promise<ContentDetail | null> {
  const collection = collectionFor(id);
  if (!collection) return null;

  const synced = await loadSyncData();
  const isSeriesCol = collection !== 'gnulahd-movies';

  const item: SyncMovie | SyncSeries | undefined = isSeriesCol
    ? (collection === 'gnulahd-series' ? synced?.gnulahdSeries : synced?.gnulahdAnime)?.find((s) => s.id === id)
    : synced?.gnulahdMovies?.find((m) => m.id === id);

  // Ítems persistidos por la búsqueda desde PelisPlus/PelisPedia: se resuelven
  // desde su proveedor de origen, nunca desde GNULA (su slug puede coincidir
  // con otro contenido ahí).
  const isExternal = item?.source === 'pelisplus' || item?.source === 'pelispedia';
  const isAnime = id.startsWith('gani_');
  const isLegacyId = id.startsWith('mov_') || id.startsWith('ser_');

  // Los ítems del catálogo legacy (mov_/ser_, sincronizados desde pelisplus
  // pero con contenido en GNULA) no viven en las colecciones v2; se busca aquí
  // su título para poder validar el contenido que devuelva GNULA.
  const legacyItem: SyncMovie | SyncSeries | undefined = isLegacyId
    ? (id.startsWith('mov_') ? synced?.movies?.find((m) => m.id === id) : synced?.series?.find((s) => s.id === id))
    : undefined;
  const catalogTitle = item?.title || legacyItem?.title;

  // El contenido cacheado solo se confía si su título corresponde al del
  // catálogo (no aplica a anime: jkanime/latanime usan títulos propios) Y
  // está vigente (menos de CONTENT_TTL_MS). Si está vencido se re-resuelve
  // para refrescar capítulos.
  const contentUsable =
    !!item?.content &&
    isContentFresh(item.contentUpdatedAt) &&
    (isAnime || !item.title || !item.content.title || titlesMatchExact(item.content.title, item.title));
  // Solo se restaura el contenido previo si el motivo de invalidación fue la
  // antigüedad (no un desajuste de título, que protege contra hijacks).
  const staleOnly = !!item?.content && !isContentFresh(item.contentUpdatedAt);
  const previousContent = item?.content;
  if (item?.content && !contentUsable) {
    logger.warn({ id, updatedAt: item.contentUpdatedAt, cached: item.content.title, catalog: item.title }, 'Contenido cacheado no corresponde o está vencido; se re-resuelve');
    item.content = undefined;
    (item as SyncSeries).seasons = undefined;
    (item as SyncMovie).videos = undefined;
  }

  const isComplete = isSeriesCol
    ? !!((item as SyncSeries | undefined)?.seasons?.length)
    : !!((item as SyncMovie | undefined)?.videos?.length);

  if (item && item.content) {
    return isSeriesCol ? mapGnulahdSeries(item as SyncSeries) : mapGnulahdMovie(item as SyncMovie);
  }

  if (item && isComplete) {
    return isSeriesCol ? mapGnulahdSeries(item as SyncSeries) : mapGnulahdMovie(item as SyncMovie);
  }

  // Los ids nativos de GNULA usan slugs con guiones (gmov_dragon-ball-z-...).
  // Los convertidos desde PelisPlus/PelisPedia llevan guiones bajos
  // (gser_malcolm_el_de_en_medio) y los de anime (gani_...) son convención
  // propia (jkanime/latanime): en ambos casos se va directo al respaldo sin
  // quemar reintentos en un 404. Los externos tampoco usan GNULA: su slug
  // puede resolver a otro contenido ahí (hijack por slug corto).
  // Los legacy (mov_/ser_ del catálogo sincronizado) sí existen en GNULA con
  // guiones: se convierten (guiones bajos → guiones) y se validan por título.
  const nativeSlug = id.slice(id.indexOf('_') + 1);
  const gnulahdId = isLegacyId
    ? `${id.startsWith('mov_') ? 'gmov_' : 'gser_'}${id.slice(4).replace(/_/g, '-')}`
    : id;
  const shouldSkipGnula = isExternal || isAnime || (!isLegacyId && nativeSlug.includes('_'));
  const scraped = shouldSkipGnula ? null : await scrapeGnulahdDetail(gnulahdId);
  if (scraped) {
    const scrapedComplete = isSeriesCol ? !!scraped.seasons?.length : !!scraped.videos?.length;
    const scrapedMatches = isAnime || !scraped.title || !catalogTitle || titlesMatchExact(scraped.title, catalogTitle);
    if (scrapedComplete && scrapedMatches) {
      await healGnulahd(collection, { ...scraped, id }, item?.source);
    }
    if (scrapedMatches) return { ...scraped, id };
    logger.warn({ id, scraped: scraped.title, catalog: catalogTitle }, 'GNULA devolvió otro contenido para el ítem; se busca en los proveedores de respaldo');
  }

  // Título que GNULA no tiene pero sí existe en PelisPlus HD: se scrapea con el
  // mismo slug, se guarda en la colección v2 y se devuelve. Si el ítem vino de
  // PelisPedia, se intenta ahí primero.
  if (collection !== 'gnulahd-anime') {
    // Cubre ids nativos (gmov_/gser_), legacy (mov_/ser_) y convertidos.
    const slug = id.replace(/^g?(?:mov|ser|ani)_/, '');
    const fetchPelisPlus = () => (isSeriesCol ? scrapeSeriesDetail(`ser_${slug}`) : scrapeMovieDetail(`mov_${slug}`));
    const fetchPelisPedia = () => (isSeriesCol ? scrapePelisPediaSeriesDetail(`ser_${slug}`) : scrapePelisPediaMovieDetail(`mov_${slug}`));
    const order: Array<['pelisplus' | 'pelispedia', typeof fetchPelisPlus]> = isExternal && item?.source === 'pelispedia'
      ? [['pelispedia', fetchPelisPedia], ['pelisplus', fetchPelisPlus]]
      : [['pelisplus', fetchPelisPlus], ['pelispedia', fetchPelisPedia]];
    for (const [provider, fetchDetail] of order) {
      const detail = await fetchDetail();
      const providerComplete = isSeriesCol ? !!detail?.seasons?.length : !!detail?.videos?.length;
      if (detail && providerComplete) {
        // El contenido debe corresponder al título del ítem; si no, se prueba
        // el siguiente proveedor.
        if (!isAnime && detail.title && item?.title && !titlesMatchExact(detail.title, item.title)) {
          logger.warn({ id, provider, scraped: detail.title, catalog: item.title }, 'Proveedor devolvió otro contenido; se prueba el siguiente');
          continue;
        }
        const normalized: ContentDetail = { ...detail, id };
        await healGnulahd(collection, normalized, isExternal ? item?.source : undefined);
        return normalized;
      }
    }
  } else {
    // Anime: el catálogo usa slugs de jkanime (subtitulado); el latino de
    // latanime se busca por título y se mezcla por episodio.
    const slug = id.replace(/^gani_/, '');
    const animeDetail = await scrapeAnimeContent(slug, item?.title, slug);
    if (animeDetail) {
      await healGnulahd('gnulahd-anime', animeDetail);
      return animeDetail;
    }
  }

  // Si todo falló pero el ítem ya tenía contenido vencido (no un hijack por
  // título), se devuelve el viejo en vez de dejar el ítem sin contenido.
  if (!item) return null;
  if (previousContent && staleOnly) {
    item.content = previousContent;
    (item as SyncSeries).seasons = (previousContent as ContentDetail).seasons;
    (item as SyncMovie).videos = (previousContent as ContentDetail).videos;
  }
  return isSeriesCol ? mapGnulahdSeries(item as SyncSeries) : mapGnulahdMovie(item as SyncMovie);
}

/** Contenido de anime on-demand: JKAnime (subtitulado) como base de episodios
 *  y Latanime (latino) como refuerzo por episodio. El subtitulado suele tener
 *  más capítulos que el latino; se conservan todos y solo se marcan con
 *  servidores en latino los que existan en latanime.
 *  knownJkanimeSlug / knownLatanimeSlug evitan la búsqueda previa cuando el
 *  slug ya se conoce (catálogo / calendario / emisión). */
export async function scrapeAnimeContent(slug: string, fallbackTitle?: string, knownJkanimeSlug?: string, knownLatanimeSlug?: string): Promise<ContentDetail | null> {
  const pushAnimeLog = (message: string) => pushLog('gnulahdAnime', message);
  const base: ContentDetail = {
    id: `gani_${slug}`,
    title: fallbackTitle || slug,
    description: fallbackTitle ? `${fallbackTitle} disponible en Veamos TV.` : '',
    rating: 8.0,
    year: 2024,
    genres: ['Anime'],
    cast: [{ name: 'Reparto Principal' }],
    type: 'anime',
  };

  const jkanime = await scrapeJkanimeDetail(slug, pushAnimeLog, knownJkanimeSlug);
  // El slug conocido (catálogo jkanime o calendario/emisión de latanime) se
  // intenta directo en latanime y, si no existe ahí, se cae a la búsqueda.
  const latanime = await scrapeLatanimeDetail(slug, pushAnimeLog, knownLatanimeSlug || slug, fallbackTitle || slug);
  if (!jkanime?.seasons?.length && !latanime?.seasons?.length) return null;

  const mergedSeasons = mergeAnimeSources(jkanime?.seasons, latanime?.seasons);
  const seasons = mergedSeasons || (jkanime?.seasons?.length ? jkanime.seasons : latanime?.seasons);
  if (!seasons?.length) return null;
  // El título real viene de la fuente que aportó el contenido: jkanime (ya
  // llega por fallbackTitle del catálogo) o el h3 de latanime (subtítulo).
  const title = jkanime?.seasons?.length ? base.title : (latanime?.title || base.title);
  const totalEpisodes = seasons.reduce((total, season) => total + season.episodes.length, 0);
  const totalServers = seasons.reduce(
    (total, season) => total + season.episodes.reduce((count, episode) => count + serverCount(episode.videos), 0),
    0,
  );
  pushAnimeLog(`Contenido listo para ${title}: ${seasons.length} temporadas, ${totalEpisodes} episodios, ${totalServers} servidores`);
  return { ...base, title, seasons };
}
