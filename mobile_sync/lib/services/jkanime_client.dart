import 'dart:convert';
import 'dart:io';

import 'package:html/parser.dart' as html_parser;
import '../models.dart';

/// Cliente ligero para scrapear JKAnime directamente desde la IP residencial
/// del dispositivo móvil (evitando cualquier bloqueo de Cloudflare en datacenters).
class JkanimeClient {
  static const String baseUrl = 'https://jkanime.net';
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
    req.headers.set(HttpHeaders.acceptHeader, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    req.headers.set(HttpHeaders.acceptLanguageHeader, 'es-ES,es;q=0.9,en;q=0.8');
    final res = await req.close().timeout(const Duration(seconds: 30));
    return await res.transform(utf8.decoder).join().timeout(const Duration(seconds: 30));
  }

  /// Scrapea el home completo de JKAnime:
  /// - Banners del carrusel hero
  /// - Programación (últimos episodios)
  /// - Top Anime
  /// - Directorio (páginas 1 a [pages])
  Future<AnimeHomeData> scrapeAnimeHome({int pages = 3}) async {
    _log?.call('Scrapeando portada de JKAnime (banners, programación, top)...');
    final homeHtml = await _fetch(baseUrl);
    final doc = html_parser.parse(homeHtml);

    // 1. Banners
    final banners = <BannerItem>[];
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

    // 2. Programación (últimos episodios)
    final schedule = <MediaItem>[];
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

    // 3. Top Anime
    final topAnime = <MediaItem>[];
    final seenTop = <String>{};
    for (final el in doc.querySelectorAll('.row.upto .col.toplist .card a[href], .row.lower .col.toplist .card a[href]')) {
      final href = el.attributes['href'] ?? '';
      final slug = href.replaceAll(RegExp(r'/+$'), '').split('/').lastWhere((s) => s.isNotEmpty, orElse: () => '');
      if (slug.isEmpty || seenTop.contains(slug)) continue;
      seenTop.add(slug);
      final title = el.querySelector('.card-title')?.text.trim() ?? '';
      if (title.isEmpty) continue;
      final poster = el.querySelector('.card-img img')?.attributes['src'];
      final rankText = el.querySelector('[data-rank]')?.attributes['data-rank'];
      final rank = rankText != null ? int.tryParse(rankText) : null;
      topAnime.add(MediaItem(id: 'gani_$slug', title: title, poster: poster, type: 'anime', rating: rank?.toDouble()));
    }
    _log?.call('JKAnime top: ${topAnime.length} animes');

    // 4. Directorio
    final todos = <MediaItem>[];
    final seen = <String>{};
    int totalCount = 0;
    final totalPagesToScan = pages < 1 ? 1 : pages;
    for (var p = 1; p <= totalPagesToScan; p++) {
      try {
        _log?.call('JKAnime directorio: escaneando página $p/$totalPagesToScan...');
        final dirHtml = await _fetch('$baseUrl/directorio?p=$p');
        final match = RegExp(r'var animes = (\{[\s\S]*?\});').firstMatch(dirHtml);
        if (match != null) {
          final jsonStr = match.group(1);
          if (jsonStr != null) {
            final json = jsonDecode(jsonStr) as Map<String, dynamic>;
            totalCount = (json['total'] as num?)?.toInt() ?? totalCount;
            final data = (json['data'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
            for (final item in data) {
              final slug = item['slug'] as String?;
              final tipo = item['tipo'] as String?;
              if (slug == null || tipo == 'Pelicula' || seen.contains(slug)) continue;
              seen.add(slug);
              todos.add(MediaItem(
                id: 'gani_$slug',
                title: item['title'] as String? ?? slug,
                poster: item['image'] as String?,
                description: item['synopsis'] as String?,
                type: 'anime',
              ));
            }
          }
        }
      } catch (e) {
        _log?.call('Página $p error: $e');
      }
    }
    _log?.call('JKAnime catálogo: ${todos.length} animes sincronizados ($totalCount total en directorio)');

    return AnimeHomeData(
      banners: banners,
      ultimosEpisodios: schedule,
      ultimasTemporadas: const [],
      topAnime: topAnime,
      todos: todos,
      totalTodos: totalCount > 0 ? totalCount : todos.length,
      updatedAt: DateTime.now().millisecondsSinceEpoch,
    );
  }
}
