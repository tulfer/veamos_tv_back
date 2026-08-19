import { BannerItem, MediaItem } from '../types';
import { getRow, setRow, storeKeys } from '../services/store';

/**
 * Datos de la sección Anime del panel de sincronización.
 * Fuentes: banner y catálogo de jkanime.net, últimas temporadas y calendario
 * de latanime.org (audio latino), programación y top de jkanime.net.
 */
export interface AnimeHomeData {
  banners: BannerItem[];
  calendario: { day: string; items: MediaItem[] } | null;
  ultimosEpisodios: MediaItem[];
  ultimasTemporadas: MediaItem[];
  topAnime: MediaItem[];
  todos: MediaItem[];
  totalTodos: number;
  updatedAt: number;
}

export async function saveAnimeHomeData(data: AnimeHomeData): Promise<void> {
  await setRow(storeKeys.animeHome, { ...data, updatedAt: Date.now() });
}

export async function loadAnimeHomeData(): Promise<AnimeHomeData | null> {
  return getRow<AnimeHomeData>(storeKeys.animeHome);
}