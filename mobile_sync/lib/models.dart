// Modelos que reflejan los tipos del backend (`src/types/index.ts`).
// La serialización JSON usa los nombres snake_case que espera el backend
// (episode_number, season_number, stream_url, etc.).

class VideoServer {
  final String name;
  final String url;

  VideoServer({required this.name, required this.url});

  Map<String, dynamic> toJson() => {'name': name, 'url': url};

  factory VideoServer.fromJson(Map<String, dynamic> json) => VideoServer(
        name: json['name'] as String? ?? 'Servidor',
        url: json['url'] as String? ?? '',
      );
}

class VideoLanguage {
  final String language;
  final List<VideoServer> servers;

  VideoLanguage({required this.language, required this.servers});

  Map<String, dynamic> toJson() => {
        'language': language,
        'servers': servers.map((s) => s.toJson()).toList(),
      };
}

class CastMember {
  final String name;
  final String? photo;
  final String? character;

  const CastMember({required this.name, this.photo, this.character});

  Map<String, dynamic> toJson() => {
        'name': name,
        if (photo != null) 'photo': photo,
        if (character != null) 'character': character,
      };
}

class Episode {
  final String id;
  final String title;
  final String duration;
  final String? description;
  final String? thumbnail;
  final String? videoUrl;
  List<VideoLanguage>? videos;
  final int episodeNumber;

  Episode({
    required this.id,
    required this.title,
    required this.duration,
    this.description,
    this.thumbnail,
    this.videoUrl,
    this.videos,
    required this.episodeNumber,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'duration': duration,
        if (description != null) 'description': description,
        if (thumbnail != null) 'thumbnail': thumbnail,
        if (videoUrl != null) 'video_url': videoUrl,
        if (videos != null) 'videos': videos!.map((v) => v.toJson()).toList(),
        'episode_number': episodeNumber,
      };
}

class Season {
  final int seasonNumber;
  final String? title;
  final List<Episode> episodes;

  Season({required this.seasonNumber, this.title, required this.episodes});

  Map<String, dynamic> toJson() => {
        'season_number': seasonNumber,
        if (title != null) 'title': title,
        'episodes': episodes.map((e) => e.toJson()).toList(),
      };
}

class DownloadLink {
  final String name;
  final String url;
  final String? lang;
  final String? quality;

  DownloadLink({required this.name, required this.url, this.lang, this.quality});

  Map<String, dynamic> toJson() => {
        'name': name,
        'url': url,
        if (lang != null) 'lang': lang,
        if (quality != null) 'quality': quality,
      };
}

class ContentDetail {
  final String id;
  final String title;
  final String description;
  final String? backdrop;
  final String? poster;
  final double rating;
  final int year;
  final String? duration;
  final String? country;
  final List<String> genres;
  final List<CastMember> cast;
  List<VideoLanguage>? videos;
  List<DownloadLink>? downloads;
  final String type; // movie | series | anime
  List<Season>? seasons;

  ContentDetail({
    required this.id,
    required this.title,
    required this.description,
    this.backdrop,
    this.poster,
    required this.rating,
    required this.year,
    this.duration,
    this.country,
    required this.genres,
    required this.cast,
    this.videos,
    this.downloads,
    required this.type,
    this.seasons,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'description': description,
        if (backdrop != null) 'backdrop': backdrop,
        if (poster != null) 'poster': poster,
        'rating': rating,
        'year': year,
        if (duration != null) 'duration': duration,
        if (country != null) 'country': country,
        'genres': genres,
        'cast': cast.map((c) => c.toJson()).toList(),
        if (videos != null) 'videos': videos!.map((v) => v.toJson()).toList(),
        if (downloads != null) 'downloads': downloads!.map((d) => d.toJson()).toList(),
        'type': type,
        if (seasons != null) 'seasons': seasons!.map((s) => s.toJson()).toList(),
      };
}

class MediaItem {
  final String id;
  final String title;
  final String? poster;
  final String? backdrop;
  final double? rating;
  final int? year;
  final String type; // movie | series | anime
  List<String>? genres;
  final String? description;

  MediaItem({
    required this.id,
    required this.title,
    this.poster,
    this.backdrop,
    this.rating,
    this.year,
    required this.type,
    this.genres,
    this.description,
  });

  /// Reconstruye un ítem desde el listado ligero del backend
  /// (`GET /sync/gnulahd/items`), suficiente para scrapear su detalle.
  factory MediaItem.fromExistingJson(Map<String, dynamic> json) => MediaItem(
        id: json['id'] as String? ?? '',
        title: json['title'] as String? ?? json['id'] as String? ?? '',
        poster: json['poster'] as String?,
        backdrop: json['backdrop'] as String?,
        rating: (json['rating'] as num?)?.toDouble(),
        year: (json['year'] as num?)?.toInt(),
        type: json['type'] as String? ?? 'movie',
        genres: (json['genres'] as List?)?.cast<String>(),
        description: json['description'] as String?,
      );

  Map<String, dynamic> toCatalogJson() => {
        'id': id,
        'title': title,
        if (poster != null) 'poster': poster,
        if (rating != null) 'rating': rating,
        if (year != null) 'year': year,
        if (description != null) 'description': description,
        if (genres != null) 'genres': genres,
        'type': type,
      };
}

class BannerItem extends MediaItem {
  final String image;

  BannerItem({
    required super.id,
    required super.title,
    required this.image,
    super.backdrop,
    super.poster,
    super.rating,
    super.year,
    required super.type,
    super.genres,
    super.description,
  });

  Map<String, dynamic> toJson() => {
        ...toCatalogJson(),
        'image': image,
      };
}

class Section {
  final String title;
  final String type; // movies | series | anime
  final List<MediaItem> items;
  final String seeAllRoute;
  final int totalItems;

  Section({
    required this.title,
    required this.type,
    required this.items,
    required this.seeAllRoute,
    required this.totalItems,
  });

  Map<String, dynamic> toJson() => {
        'title': title,
        'type': type,
        'items': items.map((i) => i.toCatalogJson()).toList(),
        'seeAllRoute': seeAllRoute,
        'totalItems': totalItems,
      };
}

class GnulahdHomeData {
  final List<BannerItem> banners;
  final List<Section> sections;
  final int updatedAt;

  GnulahdHomeData({
    required this.banners,
    required this.sections,
    required this.updatedAt,
  });

  Map<String, dynamic> toJson() => {
        'banners': banners.map((b) => b.toJson()).toList(),
        'sections': sections.map((s) => s.toJson()).toList(),
        'updatedAt': updatedAt,
      };
}