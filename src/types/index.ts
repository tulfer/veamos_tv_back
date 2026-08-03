export interface MediaItem {
  id: string;
  title: string;
  description?: string;
  poster?: string;
  backdrop?: string;
  rating?: number;
  year?: number;
  type: 'movie' | 'series' | 'live';
  genres?: string[];
}

export interface BannerItem extends MediaItem {
  image: string;
}

export interface Section {
  title: string;
  type: 'movies' | 'series' | 'live';
  items: MediaItem[];
  seeAllRoute: string;
  totalItems: number;
}

export interface HomeResponse {
  banners: BannerItem[];
  sections: Section[];
}

export interface VideoServer {
  name: string;
  url: string;
}

export interface VideoLanguage {
  language: string;
  servers: VideoServer[];
}

export interface VideoInfo {
  stream_url: string;
  type: 'hls' | 'dash' | 'mp4';
  quality?: string;
}

export interface CastMember {
  name: string;
  photo?: string;
  character?: string;
}

export interface Episode {
  id: string;
  title: string;
  duration: string;
  description?: string;
  thumbnail?: string;
  video_url?: string;
  videos?: VideoLanguage[];
  episode_number: number;
}

export interface Season {
  season_number: number;
  title?: string;
  episodes: Episode[];
}

export interface DownloadLink {
  name: string;
  url: string;
  lang?: string;
  quality?: string;
}

export interface ContentDetail {
  id: string;
  title: string;
  description: string;
  backdrop?: string;
  poster?: string;
  rating: number;
  year: number;
  duration?: string;
  country?: string;
  genres: string[];
  cast: CastMember[];
  video?: VideoInfo;
  videos?: VideoLanguage[];
  downloads?: DownloadLink[];
  type: 'movie' | 'series' | 'live';
  seasons?: Season[];
}

export interface LiveChannel {
  id: string;
  title: string;
  logo?: string;
  group?: string;
  url?: string;
  country?: string;
  type: 'live';
  online: boolean;
  /** URL del proveedor para refrescar cuando la url del video expire */
  refreshUrl?: string;
  /** Opción seleccionada al agregar el canal (para refrescar con la misma opción) */
  refreshOption?: string;
  /** Proveedor del canal: wsdeportes, cablevisionhd, tvporinternet2 */
  proveedor?: string;
  /** Fecha de expiración del stream (timestamp unix segundos) tal como viene en la URL, si la tiene */
  expires?: number;
  /** Fecha de expiración del stream en formato legible, si la tiene */
  expiresDate?: string;
}

export interface UserProfile {
  id: string;
  name: string;
  avatar?: string;
  pin?: string;
  isChild: boolean;
}

export interface UserDocument {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  createdAt: number;
  profiles: UserProfile[];
}

export interface FavoriteItem {
  id: string;
  title: string;
  poster?: string;
  type: 'movie' | 'series' | 'live';
  addedAt: number;
}

export interface ContinueWatchingItem {
  id: string;
  title: string;
  poster?: string;
  type: 'movie' | 'series' | 'live';
  progress: number;
  duration: number;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  updatedAt: number;
}

export interface HistoryItem {
  id: string;
  title: string;
  poster?: string;
  type: 'movie' | 'series' | 'live';
  watchedAt: number;
  progress: number;
  duration: number;
}

export interface SyncMovie {
  id: string;
  title: string;
  poster?: string;
  backdrop?: string;
  rating?: number;
  year?: number;
  description?: string;
  genres?: string[];
  cast?: CastMember[];
  duration?: string;
  country?: string;
  videos?: VideoLanguage[];
  downloads?: DownloadLink[];
}

export interface SyncSeries {
  id: string;
  title: string;
  poster?: string;
  backdrop?: string;
  rating?: number;
  year?: number;
  description?: string;
  genres?: string[];
  cast?: CastMember[];
  country?: string;
  seasons?: Season[];
  videos?: VideoLanguage[];
  downloads?: DownloadLink[];
}

export interface SyncData {
  movies: SyncMovie[];
  series: SyncSeries[];
  channels: LiveChannel[];
  popularMovies: MediaItem[];
  popularSeries: MediaItem[];
  estrenoMovies: SyncMovie[];
  estrenoSeries: SyncSeries[];
  gnulahdMovies?: SyncMovie[];
  gnulahdSeries?: SyncSeries[];
  gnulahdAnime?: SyncSeries[];
  updatedAt: number;
}

export interface SearchResult {
  items: MediaItem[];
  total: number;
  query: string;
  totalPages?: number;
}
