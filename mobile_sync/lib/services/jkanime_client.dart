import 'dart:convert';
import 'dart:io';

import 'package:html/parser.dart' as html_parser;
import '../models.dart';

/// Cliente para scrapear la sección Anime (JKAnime + Latanime) directamente
/// desde la IP residencial del celular (evitando bloqueos de Cloudflare en datacenters).
class JkanimeClient {
  static const String jkanimeBase = 'https://jkanime.net';
  static const String latanimeBase = 'https://latanime.org';
  final HttpClient _client;
  final void Function(String message)? _log;

  JkanimeClient({void Function(String message)? log})
      : _log = log,
        _client = HttpClient()
          ..connectionTimeout = const Duration(seconds: 25)
          ..userAgent =
              'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

  Future<String> _fetch(String url) async {
    final uri = Uri.parse(url);
    final req = await _client.getUrl(uri);
    req.headers.set(HttpHeaders.userAgentHeader,
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36');
    req.headers.set(HttpHeaders.acceptHeader,
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
    req.headers.set(HttpHeaders.acceptLanguageHeader, 'es-ES,es;q=0.9,en;q=0.8');
    req.headers.set('sec-ch-ua', '"Not/A)Brand";v="8", "Chromium";v="126", "Android WebView";v="126"');
    req.headers.set('sec-ch-ua-mobile', '?1');
    req.headers.set('sec-ch-ua-platform', '"Android"');
    req.headers.set('sec-fetch-dest', 'document');
    req.headers.set('sec-fetch-mode', 'navigate');
    req.headers.set('sec-fetch-site', 'none');
    req.headers.set('sec-fetch-user', '?1');
    req.headers.set('upgrade-insecure-requests', '1');

    final res = await req.close().timeout(const Duration(seconds: 25));
    if (res.statusCode >= 400) {
      throw HttpException('HTTP ${res.statusCode}', uri: uri);
    }
    return await res.transform(utf8.decoder).join().timeout(const Duration(seconds: 25));
  }

  /// Scrapea la sección completa de Anime combinando JKAnime (portada y catálogo)
  /// y Latanime (calendario, emisión y respaldo), exactamente igual que la web.
  Future<AnimeHomeData> scrapeAnimeHome({int pages = 1}) async {
    // 1. Banners de JKAnime
    final banners = <BannerItem>[];
    _log?.call('Scrapeando banner de jkanime.net...');
    try {
      final homeHtml = await _fetch(jkanimeBase);
      final doc = html_parser.parse(homeHtml);
      for (final el in doc.querySelectorAll('.hero__slider .hero__items')) {
        final backdrop = el.attributes['data-setbg'] ?? '';
        if (backdrop.isEmpty) continue;
        final title = el.querySelector('.hero__text h2')?.text.trim() ?? '';
        if (title.isEmpty) continue;
        final desc = el.querySelector('.hero__text p')?.text.trim();
        final href = el.querySelector('a')?.attributes['href'] ?? '';
        final slug = href.replaceAll(RegExp(r'/+$'), '').split('/').lastWhere((s) => s.isNotEmpty, orElse: () => '');
        if (slug.isEmpty) continue;
        banners.add(BannerItem(
          id: 'gani_$slug',
          title: title,
          image: backdrop,
          backdrop: backdrop,
          poster: backdrop,
          type: 'anime',
          description: desc,
        ));
      }
      _log?.call('JKAnime banner: ${banners.length} banners');
    } catch (e) {
      _log?.call('JKAnime banner aviso: $e');
    }

    // 2. Calendario de Latanime (día de hoy)
    Map<String, dynamic>? calendario;
    final dayNames = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    final today = dayNames[DateTime.now().weekday % 7];
    final dayLabel = today[0].toUpperCase() + today.substring(1);
    _log?.call('Scrapeando calendario de latanime.org ($today)...');
    try {
      final calHtml = await _fetch('$latanimeBase/calendario');
      final doc = html_parser.parse(calHtml);
      final pane = doc.querySelector('#$today-tap-pane') ?? doc;
      final calItems = <MediaItem>[];
      final seenCal = <String>{};
      for (final el in pane.querySelectorAll('a[href*="/anime/"]')) {
        final href = el.attributes['href'] ?? '';
        final slug = href.split('/').where((s) => s.isNotEmpty).lastOrNull ?? '';
        if (slug.isEmpty || !seenCal.add(slug)) continue;
        final title = el.querySelector('h3')?.text.trim() ?? '';
        if (title.isEmpty) continue;
        final img = el.querySelector('img');
        final poster = img?.attributes['data-src'] ?? img?.attributes['src'];
        calItems.add(MediaItem(id: 'gani_$slug', title: title, poster: poster, type: 'anime'));
      }
      calendario = {'day': dayLabel, 'items': calItems.map((m) => m.toCatalogJson()).toList()};
      _log?.call('Latanime calendario ($dayLabel): ${calItems.length} animes');
    } catch (e) {
      _log?.call('Latanime calendario aviso: $e');
    }

    // 3. Últimas temporadas / emisión de Latanime
    final ultimasTemporadas = <MediaItem>[];
    _log?.call('Scrapeando últimas temporadas de latanime.org/emision...');
    try {
      final emisionHtml = await _fetch('$latanimeBase/emision');
      final doc = html_parser.parse(emisionHtml);
      final seenEmi = <String>{};
      for (final el in doc.querySelectorAll('a[href*="/anime/"]')) {
        final href = el.attributes['href'] ?? '';
        final slug = href.split('/').where((s) => s.isNotEmpty).lastOrNull ?? '';
        if (slug.isEmpty || !seenEmi.add(slug)) continue;
        final title = el.querySelector('h3')?.text.trim() ?? '';
        if (title.isEmpty) continue;
        final img = el.querySelector('img');
        final poster = img?.attributes['data-src'] ?? img?.attributes['src'];
        final yearText = el.querySelector('span[style*="ffc119"]')?.text ?? '';
        final yearMatch = RegExp(r'\b(19|20)\d{2}\b').firstMatch(yearText);
        final year = yearMatch != null ? int.tryParse(yearMatch.group(0)!) : null;
        ultimasTemporadas.add(MediaItem(id: 'gani_$slug', title: title, poster: poster, year: year, type: 'anime'));
      }
      _log?.call('Latanime emisión: ${ultimasTemporadas.length} animes');
    } catch (e) {
      _log?.call('Latanime emisión aviso: $e');
    }

    // Respaldo de banners si JKAnime no devolvió
    if (banners.isEmpty && ultimasTemporadas.isNotEmpty) {
      for (final item in ultimasTemporadas.take(8)) {
        banners.add(BannerItem(
          id: item.id,
          title: item.title,
          image: item.poster ?? '',
          backdrop: item.poster,
          poster: item.poster,
          type: 'anime',
        ));
      }
      _log?.call('Fallback: ${banners.length} banners creados desde emisión');
    }

    // 4. Programación (últimos episodios) de JKAnime
    final schedule = <MediaItem>[];
    _log?.call('Scrapeando programación (últimos episodios) de jkanime.net...');
    try {
      final homeHtml = await _fetch(jkanimeBase);
      final doc = html_parser.parse(homeHtml);
      for (final el in doc.querySelectorAll('#animes .dir1 > .card > a')) {
        final href = el.attributes['href'] ?? '';
        final parts = href.replaceAll(RegExp(r'/+$'), '').split('/').where((s) => s.isNotEmpty).toList();
        final slug = parts.length >= 2 ? parts[parts.length - 2] : '';
        if (slug.isEmpty) continue;
        final title = el.querySelector('.card-title')?.text.trim() ?? '';
        if (title.isEmpty) continue;
        final img = el.querySelector('img');
        final poster = img?.attributes['data-animepic'] ?? img?.attributes['src'];
        schedule.add(MediaItem(id: 'gani_$slug', title: title, poster: poster, type: 'anime'));
      }
      _log?.call('JKAnime programación: ${schedule.length} últimos episodios');
    } catch (e) {
      _log?.call('JKAnime programación aviso: $e');
    }
    if (schedule.isEmpty && ultimasTemporadas.isNotEmpty) {
      schedule.addAll(ultimasTemporadas.take(20));
      _log?.call('Fallback programación: ${schedule.length} episodios desde emisión');
    }

    // 5. Top Anime de JKAnime
    final topAnime = <MediaItem>[];
    _log?.call('Scrapeando Top Anime de jkanime.net...');
    try {
      final homeHtml = await _fetch(jkanimeBase);
      final doc = html_parser.parse(homeHtml);
      final seenTop = <String>{};
      for (final el in doc.querySelectorAll('.row.upto .col.toplist .card a[href], .row.lower .col.toplist .card a[href]')) {
        final href = el.attributes['href'] ?? '';
        final slug = href.replaceAll(RegExp(r'/+$'), '').split('/').lastWhere((s) => s.isNotEmpty, orElse: () => '');
        if (slug.isEmpty || !seenTop.add(slug)) continue;
        final title = el.querySelector('.card-title')?.text.trim() ?? '';
        if (title.isEmpty) continue;
        final poster = el.querySelector('.card-img img')?.attributes['src'];
        final rankText = el.querySelector('[data-rank]')?.attributes['data-rank'];
        final rank = rankText != null ? int.tryParse(rankText) : null;
        topAnime.add(MediaItem(id: 'gani_$slug', title: title, poster: poster, type: 'anime', rating: rank?.toDouble()));
      }
      _log?.call('JKAnime top: ${topAnime.length} animes');
    } catch (e) {
      _log?.call('JKAnime top aviso: $e');
    }
    if (topAnime.isEmpty && ultimasTemporadas.isNotEmpty) {
      topAnime.addAll(ultimasTemporadas.take(10));
      _log?.call('Fallback top: ${topAnime.length} animes desde emisión');
    }

    // 6. Directorio (JKAnime con fallback a Latanime)
    final todos = <MediaItem>[];
    final seen = <String>{};

    void addItems(List<MediaItem> list) {
      for (final item in list) {
        if (seen.add(item.id)) todos.add(item);
      }
    }

    // Incorporar emisión y calendario en el catálogo base
    addItems(ultimasTemporadas);
    if (calendario != null && calendario['items'] is List) {
      for (final e in (calendario['items'] as List)) {
        if (e is Map<String, dynamic>) {
          final id = e['id'] as String? ?? '';
          final title = e['title'] as String? ?? '';
          final poster = e['poster'] as String?;
          if (id.isNotEmpty && title.isNotEmpty) {
            addItems([MediaItem(id: id, title: title, poster: poster, type: 'anime')]);
          }
        }
      }
    }

    int totalCount = todos.length;
    final totalPagesToScan = pages <= 1 ? 5 : pages;
    bool jkanimeDirOk = false;

    for (var p = 1; p <= totalPagesToScan; p++) {
      try {
        final dirHtml = await _fetch('$jkanimeBase/directorio?p=$p');
        final match = RegExp(r'var animes = (\{[\s\S]*?\});').firstMatch(dirHtml);
        if (match != null) {
          final jsonStr = match.group(1);
          if (jsonStr != null) {
            final json = jsonDecode(jsonStr) as Map<String, dynamic>;
            totalCount = (json['total'] as num?)?.toInt() ?? totalCount;
            final data = (json['data'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
            final pageItems = <MediaItem>[];
            for (final item in data) {
              final slug = item['slug'] as String?;
              final tipo = item['tipo'] as String?;
              if (slug == null || tipo == 'Pelicula') continue;
              pageItems.add(MediaItem(
                id: 'gani_$slug',
                title: item['title'] as String? ?? slug,
                poster: item['image'] as String?,
                description: item['synopsis'] as String?,
                type: 'anime',
              ));
            }
            addItems(pageItems);
            jkanimeDirOk = true;
            _log?.call('Escaneando página $p/$totalPagesToScan del directorio (${todos.length} animes)...');
          }
        }
      } catch (e) {
        _log?.call('JKAnime directorio pág. $p aviso: $e');
        break;
      }
    }

    if (!jkanimeDirOk) {
      _log?.call('Directorio JKAnime no disponible; recurriendo a Latanime...');
      for (var p = 1; p <= totalPagesToScan; p++) {
        try {
          final dirHtml = await _fetch('$latanimeBase/animes?page=$p');
          final doc = html_parser.parse(dirHtml);
          final pageItems = <MediaItem>[];
          for (final el in doc.querySelectorAll('a[href*="/anime/"]')) {
            final href = el.attributes['href'] ?? '';
            final slug = href.split('/').where((s) => s.isNotEmpty).lastOrNull ?? '';
            if (slug.isEmpty) continue;
            final title = el.querySelector('h3')?.text.trim() ?? '';
            if (title.isEmpty) continue;
            final img = el.querySelector('img');
            final poster = img?.attributes['data-src'] ?? img?.attributes['src'];
            pageItems.add(MediaItem(id: 'gani_$slug', title: title, poster: poster, type: 'anime'));
          }
          addItems(pageItems);
          _log?.call('Escaneando página $p/$totalPagesToScan de Latanime (${todos.length} animes)...');
          if (pageItems.isEmpty) break;
        } catch (e) {
          _log?.call('Latanime directorio pág. $p aviso: $e');
          break;
        }
      }
    }
    _log?.call('Sync de anime: ${todos.length} animes en catálogo ($totalCount total)');

    return AnimeHomeData(
      banners: banners,
      calendario: calendario,
      ultimosEpisodios: schedule,
      ultimasTemporadas: ultimasTemporadas,
      topAnime: topAnime,
      todos: todos,
      totalTodos: totalCount > 0 ? totalCount : todos.length,
      updatedAt: DateTime.now().millisecondsSinceEpoch,
    );
  }

  /// Scrapea el detalle de servidores y episodios de un anime combinando
  /// JKAnime (Subtitulado) y Latanime (Latino).
  Future<ContentDetail?> scrapeAnimeDetail(MediaItem item) async {
    final slug = item.id.replaceFirst(RegExp(r'^gani_'), '');
    if (slug.isEmpty) return null;

    final base = ContentDetail(
      id: item.id,
      title: item.title,
      description: item.description ?? '${item.title} disponible en audio latino y subtitulado en Veamos TV.',
      poster: item.poster,
      backdrop: item.backdrop ?? item.poster,
      rating: item.rating ?? 8.0,
      year: item.year ?? 2024,
      genres: item.genres ?? const ['Anime'],
      cast: const [CastMember(name: 'Reparto Principal')],
      type: 'anime',
    );

    List<Season>? jkanimeSeasons;
    try {
      jkanimeSeasons = await _scrapeJkanimeSeasons(slug, item.title);
    } catch (e) {
      _log?.call('JKAnime detail error para $slug: $e');
    }

    List<Season>? latanimeSeasons;
    try {
      latanimeSeasons = await _scrapeLatanimeSeasons(slug, item.title);
    } catch (e) {
      _log?.call('Latanime detail error para $slug: $e');
    }

    final seasons = _mergeSeasons(jkanimeSeasons, latanimeSeasons) ?? jkanimeSeasons ?? latanimeSeasons;
    if (seasons == null || seasons.isEmpty) return null;

    base.seasons = seasons;
    final totalEpisodes = seasons.fold<int>(0, (acc, s) => acc + s.episodes.length);
    _log?.call('Anime "${item.title}": $totalEpisodes episodios con servidores resueltos.');
    return base;
  }

  Future<List<Season>?> _scrapeJkanimeSeasons(String slug, String title) async {
    String detailHtml;
    String currentSlug = slug;
    try {
      detailHtml = await _fetch('$jkanimeBase/$currentSlug/');
    } catch (_) {
      try {
        final searchUrl = '$jkanimeBase/buscar/${Uri.encodeComponent(title)}';
        final sHtml = await _fetch(searchUrl);
        final sDoc = html_parser.parse(sHtml);
        final found = sDoc.querySelector('.anime__item a[href], .card a[href]');
        final href = found?.attributes['href'] ?? '';
        final matchedSlug = href.replaceAll(RegExp(r'/+$'), '').split('/').lastWhere((s) => s.isNotEmpty, orElse: () => '');
        if (matchedSlug.isEmpty) return null;
        currentSlug = matchedSlug;
        detailHtml = await _fetch('$jkanimeBase/$currentSlug/');
      } catch (_) {
        return null;
      }
    }

    final doc = html_parser.parse(detailHtml);
    final numbers = <int>{};

    for (final a in doc.querySelectorAll('a[href]')) {
      final href = a.attributes['href'] ?? '';
      final m = RegExp(r'/' + RegExp.escape(currentSlug) + r'/(\d+)/?$').firstMatch(href);
      if (m != null) {
        final n = int.tryParse(m.group(1)!);
        if (n != null && n > 0) numbers.add(n);
      }
    }

    final idMatch = RegExp(r'ajax/(?:episodes|search_episode)/(\d+)', caseSensitive: false).firstMatch(detailHtml);
    if (idMatch != null) {
      final animeId = idMatch.group(1)!;
      for (var p = 1; p <= 5; p++) {
        try {
          final ajaxRes = await _fetch('$jkanimeBase/ajax/episodes/$animeId/$p');
          final json = jsonDecode(ajaxRes) as Map<String, dynamic>;
          final data = json['data'] as List?;
          if (data == null || data.isEmpty) break;
          for (final it in data) {
            final epVal = int.tryParse('${it['number']}');
            if (epVal != null && epVal > 0) numbers.add(epVal);
          }
        } catch (_) {
          break;
        }
      }
    }

    if (numbers.isEmpty) {
      try {
        await _fetch('$jkanimeBase/$currentSlug/1/');
        numbers.add(1);
      } catch (_) {}
    }

    if (numbers.isEmpty) return null;

    final sortedNums = numbers.toList()..sort();
    final numsToFetch = sortedNums.length > 50 ? sortedNums.sublist(sortedNums.length - 50) : sortedNums;
    final episodes = <Episode>[];

    for (final n in numsToFetch) {
      try {
        final epHtml = await _fetch('$jkanimeBase/$currentSlug/$n/');
        final servers = _extractJkanimeServers(epHtml);
        if (servers.isNotEmpty) {
          episodes.add(Episode(
            id: 'gani_${currentSlug}_e$n',
            title: 'Episodio $n',
            duration: '24m',
            episodeNumber: n,
            videos: [VideoLanguage(language: 'Subtitulado', servers: servers)],
          ));
        }
      } catch (_) {}
    }

    if (episodes.isEmpty) return null;
    return [Season(seasonNumber: 1, title: 'Temporada 1', episodes: episodes)];
  }

  List<VideoServer> _extractJkanimeServers(String html) {
    final servers = <VideoServer>[];
    final seenUrls = <String>{};

    final serversMatch = RegExp(r'var\s+servers\s*=\s*(\[[^\]]*\])\s*;?').firstMatch(html);
    if (serversMatch != null) {
      try {
        final jsonStr = serversMatch.group(1);
        if (jsonStr != null) {
          final list = jsonDecode(jsonStr) as List;
          for (final it in list) {
            if (it is! Map) continue;
            final sName = it['server'] as String? ?? 'Servidor';
            final remote = it['remote'] as String?;
            if (remote == null || remote.isEmpty) continue;
            try {
              String b64 = remote.replaceAll(RegExp(r'\s'), '');
              while (b64.length % 4 != 0) {
                b64 += '=';
              }
              final decoded = utf8.decode(base64Decode(b64));
              if (decoded.startsWith('http') && !decoded.contains('mediafire') && seenUrls.add(decoded)) {
                servers.add(VideoServer(name: sName, url: decoded));
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    final iframeRe = RegExp('<iframe[^>]*?src=["\'](https?://[^"\'<>]+)["\']', caseSensitive: false);
    for (final m in iframeRe.allMatches(html)) {
      final src = m.group(1)!;
      if (!src.contains('mediafire') && !src.contains('facebook') && !src.contains('google') && seenUrls.add(src)) {
        servers.add(VideoServer(name: 'Servidor', url: src));
      }
    }

    return servers;
  }

  Future<List<Season>?> _scrapeLatanimeSeasons(String slug, String title) async {
    String latHtml;
    String latSlug = slug;
    try {
      latHtml = await _fetch('$latanimeBase/anime/$latSlug');
    } catch (_) {
      try {
        final sHtml = await _fetch('$latanimeBase/buscar?q=${Uri.encodeComponent(title.replaceAll(RegExp(r'[\s_-]+'), '+'))}');
        final sDoc = html_parser.parse(sHtml);
        final a = sDoc.querySelector('a[href*="/anime/"]');
        final href = a?.attributes['href'] ?? '';
        latSlug = href.split('/').where((s) => s.isNotEmpty).lastOrNull ?? '';
        if (latSlug.isEmpty) return null;
        latHtml = await _fetch('$latanimeBase/anime/$latSlug');
      } catch (_) {
        return null;
      }
    }

    final latDoc = html_parser.parse(latHtml);
    final latLinks = <int, String>{};

    for (final a in latDoc.querySelectorAll('a[href]')) {
      final href = a.attributes['href'] ?? '';
      if (!href.contains('/ver/') && !href.contains('/capitulo-') && !href.contains('/episodio-')) continue;
      final m = RegExp(r'(?:capitulo|episodio|-)(\d+)/?$', caseSensitive: false).firstMatch(href);
      if (m != null) {
        final n = int.tryParse(m.group(1)!);
        if (n != null && n > 0 && !latLinks.containsKey(n)) {
          latLinks[n] = href.startsWith('http') ? href : '$latanimeBase$href';
        }
      }
    }

    if (latLinks.isEmpty) return null;

    final sortedLatNums = latLinks.keys.toList()..sort();
    final numsToFetch = sortedLatNums.length > 50 ? sortedLatNums.sublist(sortedLatNums.length - 50) : sortedLatNums;
    final latEpisodes = <Episode>[];

    for (final n in numsToFetch) {
      final epUrl = latLinks[n]!;
      try {
        final epHtml = await _fetch(epUrl);
        final servers = _extractLatanimeServers(epHtml);
        if (servers.isNotEmpty) {
          latEpisodes.add(Episode(
            id: 'gani_${slug}_e$n',
            title: 'Episodio $n',
            duration: '24m',
            episodeNumber: n,
            videos: [VideoLanguage(language: 'Latino', servers: servers)],
          ));
        }
      } catch (_) {}
    }

    if (latEpisodes.isEmpty) return null;
    return [Season(seasonNumber: 1, title: 'Temporada 1', episodes: latEpisodes)];
  }

  List<VideoServer> _extractLatanimeServers(String html) {
    final servers = <VideoServer>[];
    final seenUrls = <String>{};
    final doc = html_parser.parse(html);

    for (final el in doc.querySelectorAll('[data-url], [data-src], [data-video]')) {
      final raw = el.attributes['data-url'] ?? el.attributes['data-src'] ?? el.attributes['data-video'] ?? '';
      var decoded = raw;
      if (raw.length > 20 && RegExp(r'^[A-Za-z0-9+/=]+$').hasMatch(raw)) {
        try {
          String b64 = raw.replaceAll(RegExp(r'\s'), '');
          while (b64.length % 4 != 0) {
            b64 += '=';
          }
          final dec = utf8.decode(base64Decode(b64));
          if (dec.startsWith('http')) decoded = dec;
        } catch (_) {}
      }
      final label = el.text.trim();
      if (!RegExp(r'descargar|download|mega\.nz|mediafire|gofile', caseSensitive: false).hasMatch('$label $decoded')) {
        if (decoded.startsWith('http') && seenUrls.add(decoded)) {
          servers.add(VideoServer(name: label.isNotEmpty ? label : 'Servidor', url: decoded));
        }
      }
    }

    final iframeRe = RegExp('<iframe[^>]*?src=["\'](https?://[^"\'<>]+)["\']', caseSensitive: false);
    for (final m in iframeRe.allMatches(html)) {
      final src = m.group(1)!;
      if (!src.contains('mediafire') && !src.contains('facebook') && !src.contains('google') && seenUrls.add(src)) {
        servers.add(VideoServer(name: 'Servidor', url: src));
      }
    }

    return servers;
  }

  List<Season>? _mergeSeasons(List<Season>? subtitled, List<Season>? latino) {
    final base = (subtitled != null && subtitled.isNotEmpty)
        ? subtitled
        : ((latino != null && latino.isNotEmpty) ? latino : null);
    if (base == null) return null;

    final latinoEpisodes = latino?.expand((s) => s.episodes).toList() ?? const <Episode>[];

    return base.map((season) {
      final mergedEpisodes = season.episodes.map((episode) {
        final extra = latinoEpisodes.where((e) => e.episodeNumber == episode.episodeNumber).firstOrNull;
        if (extra == null || extra.videos == null || extra.videos!.isEmpty) return episode;

        final videos = List<VideoLanguage>.from(episode.videos ?? const []);
        for (final extraLang in extra.videos!) {
          if (videos.any((v) => v.language.toLowerCase() == extraLang.language.toLowerCase())) {
            continue;
          }
          videos.add(VideoLanguage(language: extraLang.language, servers: List.of(extraLang.servers)));
        }
        return Episode(
          id: episode.id,
          title: episode.title,
          duration: episode.duration,
          description: episode.description,
          thumbnail: episode.thumbnail,
          videoUrl: episode.videoUrl,
          episodeNumber: episode.episodeNumber,
          videos: videos,
        );
      }).toList();

      return Season(
        seasonNumber: season.seasonNumber,
        title: season.title,
        episodes: mergedEpisodes,
      );
    }).toList();
  }

  void close() {
    _client.close(force: true);
  }
}
