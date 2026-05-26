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

export interface ContentDetail {
  id: string;
  title: string;
  description: string;
  backdrop?: string;
  poster?: string;
  rating: number;
  year: number;
  duration?: string;
  genres: string[];
  cast: CastMember[];
  video?: VideoInfo;
  videos?: VideoLanguage[];
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
  videos?: VideoLanguage[];
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
  seasons?: Season[];
  videos?: VideoLanguage[];
}

export interface SyncData {
  movies: SyncMovie[];
  series: SyncSeries[];
  channels: LiveChannel[];
  popularMovies: MediaItem[];
  popularSeries: MediaItem[];
  estrenoMovies: SyncMovie[];
  estrenoSeries: SyncSeries[];
  updatedAt: number;
}

export interface SearchResult {
  items: MediaItem[];
  total: number;
  query: string;
  totalPages?: number;
}
