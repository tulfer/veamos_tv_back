import 'dart:convert';
import 'dart:io';

import 'package:html/parser.dart' as html_parser;
import 'package:html/dom.dart';

import '../models.dart';

/// Cliente del scraper de GNULA HD, portado del proveedor TS
/// (`src/providers/gnulahd.ts`). Sacrifica parte de la robustez del backend
/// (que usa retry + validación de dominios con caché en BD) pero mantiene:
///  - Cookie jar + paso del interstitial de DDoS-Guard (/?gnm=1)
///  - Rotación entre dominios oficiales si el principal falla
///  - Player API con desofuscación (base64 + XOR 'gN7d')
///
/// Se ejecuta desde la IP residencial del celular (DDoS-Guard bloquea
/// datacenters), por eso a diferencia del backend NO le sirve el proxy/backup.

typedef LogFn = void Function(String message);

const List<int> _gnrdXorKey = [103, 78, 55, 100]; // 'gN7d'
const String _defaultUa =
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const int maxEpisodesScrape = 60;

class GnulaClient {
  final List<String> staticDomains;
  final LogFn? _log;

  String _activeBase = '';
  final Map<String, Map<String, String>> _cookieJar = {};
  late final HttpClient _client;

  GnulaClient({required this.staticDomains, LogFn? log}) : _log = log {
    _client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
  }

  void _info(String message) => _log?.call('[gnula] $message');

  String get activeBase => _activeBase;

  // ── Transporte ────────────────────────────────────────────────────────────

  String _cookieHeaderFor(String host) {
    final cookies = _cookieJar[host];
    if (cookies == null) return '';
    return cookies.entries.map((e) => '${e.key}=${e.value}').join('; ');
  }

  void _storeCookies(String host, List<String> setCookies) {
    if (setCookies.isEmpty) return;
    final jar = _cookieJar.putIfAbsent(host, () => {});
    for (final raw in setCookies) {
      final parts = raw.split(';');
      if (parts.isEmpty) continue;
      final eq = parts.first.indexOf('=');
      if (eq <= 0) continue;
      jar[parts.first.substring(0, eq).trim()] = parts.first.substring(eq + 1).trim();
    }
  }

  Future<String> _get(String url, {String? referer}) async {
    final uri = Uri.parse(url);
    final request = await _client.getUrl(uri);
    request.headers.set(HttpHeaders.userAgentHeader, _defaultUa);
    request.headers.set(HttpHeaders.acceptHeader,
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
    request.headers.set(HttpHeaders.acceptLanguageHeader, 'es-ES,es;q=0.9,en;q=0.8');
    if (referer != null) request.headers.set(HttpHeaders.refererHeader, referer);
    if (referer == null) request.headers.set(HttpHeaders.refererHeader, url);
    final cookie = _cookieHeaderFor(uri.host);
    if (cookie.isNotEmpty) request.headers.set(HttpHeaders.cookieHeader, cookie);

    final response = await request.close().timeout(const Duration(seconds: 20));
    _storeCookies(uri.host, response.headers[HttpHeaders.setCookieHeader] ?? const []);
    final body = await response.transform(utf8.decoder).join().timeout(const Duration(seconds: 20));
    if (response.statusCode != 200) {
      throw HttpException('HTTP ${response.statusCode} para $url');
    }
    return body;
  }

  bool isUsable(String html) {
    final text = html.trim();
    if (text.length < 10000) return false;
    return RegExp(r'gnrd-card|gnrdHero|gnrd-grid|gnrd-pg-seo|wp-content', caseSensitive: false).hasMatch(text);
  }

  Future<String> _fetchFromHost(String base, String pathAndQuery, {String? referer}) async {
    Object? lastError;
    for (var attempt = 1; attempt <= 3; attempt++) {
      try {
        var html = await _get('$base$pathAndQuery', referer: referer);
        if (isUsable(html)) return html;

        if (html.contains('gnm=1') || RegExp(r'ddos-guard|__ddg', caseSensitive: false).hasMatch(html)) {
          await _get('$base/?gnm=1', referer: '$base$pathAndQuery');
          html = await _get('$base$pathAndQuery');
          if (isUsable(html)) return html;
        }

        lastError = Exception('HTML de GNULA no utilizable (posible anti-bot o vacío)');
      } catch (error) {
        lastError = error;
      }
      await Future<void>.delayed(Duration(milliseconds: 600 * attempt));
    }
    throw lastError ?? Exception('Fallo de GNULA');
  }

  /// Resuelve la base activa probando dominios estáticos + descubiertos.
  Future<void> ensureBase() async {
    if (_activeBase.isNotEmpty) return;
    for (final base in _normalizeDomains()) {
      try {
        final html = await _fetchFromHost(base, '/');
        if (isUsable(html)) {
          _activeBase = base;
          _info('dominio activo: $base');
          return;
        }
      } catch (_) {
        // siguiente dominio
      }
    }
    _activeBase = staticDomains.first;
    _info('ningún dominio respondió, usando: $_activeBase');
  }

  Future<String> fetchPage(String pathAndQuery) async {
    await ensureBase();
    final candidates = _normalizeDomains();
    Object? lastError;
    for (final base in candidates) {
      try {
        final html = await _fetchFromHost(base, pathAndQuery, referer: base);
        if (base != _activeBase) {
          _info('promovido tras fallo del principal: $base');
          _activeBase = base;
        }
        return html;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? Exception('Fallo de GNULA');
  }

  List<String> _normalizeDomains() {
    final list = <String>[];
    for (final raw in [_activeBase, ...staticDomains]) {
      final domain = raw.trim().replaceAll(RegExp(r'/+$'), '');
      if (domain.isNotEmpty && !list.contains(domain)) list.add(domain);
    }
    return list;
  }

  // ── Player API ────────────────────────────────────────────────────────────

  Map<String, dynamic> unpack(String payload) {
    try {
      final bytes = base64Decode(payload);
      final out = <int>[];
      for (var i = 0; i < bytes.length; i++) {
        out.add(bytes[i] ^ _gnrdXorKey[i % _gnrdXorKey.length]);
      }
      final parsed = jsonDecode(utf8.decode(out));
      return parsed is Map<String, dynamic> ? parsed : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  ({int? pid, String? tok})? extractPlayerVars(String html) {
    final match = RegExp(r'_gnrdPid=(\d+),\s*_gnrdTok="([a-f0-9]+)"').firstMatch(html);
    if (match == null) return null;
    return (pid: int.tryParse(match.group(1)!), tok: match.group(2));
  }

  Future<List<VideoLanguage>> fetchPlayerVideos({required int pid, required String tok, required String referer}) async {
    await ensureBase();
    final url = '$_activeBase/wp-json/gnrd/v1/player?id=$pid&t=${Uri.encodeQueryComponent(tok)}';
    final uri = Uri.parse(url);
    final request = await _client.getUrl(uri);
    request.headers.set(HttpHeaders.userAgentHeader, _defaultUa);
    request.headers.set(HttpHeaders.refererHeader, referer);
    request.headers.set('X-Requested-With', 'XMLHttpRequest');
    request.headers.set(HttpHeaders.acceptHeader, 'application/json');
    final cookie = _cookieHeaderFor(uri.host);
    if (cookie.isNotEmpty) request.headers.set(HttpHeaders.cookieHeader, cookie);

    final response = await request.close().timeout(const Duration(seconds: 15));
    _storeCookies(uri.host, response.headers[HttpHeaders.setCookieHeader] ?? const []);
    final body = await response.transform(utf8.decoder).join().timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) return const [];

    final data = unpack((jsonDecode(body) as Map<String, dynamic>?)?['p'] as String? ?? '');
    return _toVideoLanguages(data);
  }

  List<VideoLanguage> _toVideoLanguages(Map<String, dynamic> data) {
    final raw = data['langs'];
    if (raw is! Map) return const [];
    final result = <VideoLanguage>[];
    for (final lang in raw.values) {
      if (lang is! Map) continue;
      final label = lang['label'];
      final servers = lang['servers'];
      if (label is! String || label.isEmpty || servers is! List) continue;
      final list = <VideoServer>[];
      for (final server in servers) {
        if (server is! Map) continue;
        final src = server['src'];
        final title = server['title'];
        if (src is! String || src.isEmpty || _isUnsupportedVideoHost(src)) continue;
        list.add(VideoServer(name: title is String && title.isNotEmpty ? title : 'Servidor', url: src));
      }
      if (list.isNotEmpty) result.add(VideoLanguage(language: label, servers: list));
    }
    return result;
  }

  List<DownloadLink> _toDownloadLinks(Map<String, dynamic> data) {
    final dl = data['dl'];
    if (dl is! List) return const [];
    final result = <DownloadLink>[];
    for (final entry in dl) {
      if (entry is! Map) continue;
      final name = entry['name'];
      final url = entry['url'];
      if (name is! String || url is! String) continue;
      result.add(DownloadLink(
        name: name,
        url: url,
        lang: entry['lang'] as String?,
        quality: entry['qual'] as String?,
      ));
    }
    return result;
  }

  bool _isUnsupportedVideoHost(String url) {
    try {
      final host = Uri.parse(url).host.toLowerCase();
      const unsupported = {
        'dtpg.rpmplay.xyz', 'bysevepoin.com', 'ok.ru', 'voe.sx', 'savefiles.top',
        'mxdrop.to', 'streamtape.com', 'mp4upload.com', 'www.mp4upload.com',
      };
      if (unsupported.contains(host)) return true;
      return host.endsWith('.ok.ru') ||
          host.endsWith('.voe.sx') ||
          host.endsWith('.savefiles.top') ||
          host.endsWith('.mxdrop.to') ||
          host.endsWith('.streamtape.com') ||
          host.endsWith('.mp4upload.com');
    } catch (_) {
      return false;
    }
  }

  // ── Home ──────────────────────────────────────────────────────────────────

  Future<GnulahdHomeData> scrapeHome() async {
    final html = await fetchPage('/');
    final doc = html_parser.parse(html);

    final banners = <BannerItem>[];
    for (final el in doc.querySelectorAll('#gnrdHero .gnrd-slide')) {
      final banner = _parseHeroSlide(el);
      if (banner != null) banners.add(banner);
    }

    final sections = <Section>[];
    for (final el in doc.querySelectorAll('section.gnrd-row')) {
      final section = _parseHomeRow(el);
      if (section != null) sections.add(section);
    }

    if (banners.isEmpty && sections.isEmpty) {
      throw Exception('Gnulahd home sin banners ni secciones (anti-bot o vacío)');
    }
    _info('home: ${banners.length} banners, ${sections.length} secciones');
    return GnulahdHomeData(banners: banners, sections: sections, updatedAt: DateTime.now().millisecondsSinceEpoch);
  }

  BannerItem? _parseHeroSlide(Element el) {
    final backdrop = _extractImageUrl(_styleOf(el, '.gnrd-hero-bg'));
    if (backdrop == null) return null;

    final eyebrow = el.querySelector('.gnrd-eyebrow')?.text.trim().toLowerCase() ?? '';
    final isAnime = eyebrow.contains('anime');
    final isSeries = eyebrow.contains('serie') || isAnime;
    final type = isAnime ? 'anime' : isSeries ? 'series' : 'movie';

    final logoImg = el.querySelector('.gnrd-hero-logo');
    final title = logoImg?.attributes['alt']?.trim() ?? el.querySelector('.gnrd-hero-title')?.text.trim() ?? '';
    if (title.isEmpty) return null;

    final href = el.querySelector('a.gnrd-btn-play')?.attributes['href'] ?? '';
    final slug = _extractSlug(href).isNotEmpty ? _extractSlug(href) : _slugify(title);
    final prefix = type == 'anime' ? 'gani_' : type == 'movie' ? 'gmov_' : 'gser_';

    final rating = _parseRating(el.querySelector('.gnrd-m-rating')?.text ?? '');
    final metaSpans = el
        .querySelectorAll('.gnrd-hero-meta > span:not(.gnrd-m-rating)')
        .map((s) => s.text.trim())
        .toList();
    final year = int.tryParse(metaSpans.isNotEmpty ? metaSpans.first : '') ?? 0;
    final genres = el.querySelectorAll('.gnrd-hero-meta .gnrd-genre').map((g) => g.text.trim()).toList();
    final synopsis = el.querySelector('.gnrd-hero-syn')?.text.trim() ?? '';
    final poster = logoImg?.attributes['src'];

    return BannerItem(
      id: '$prefix$slug',
      title: title,
      image: backdrop,
      backdrop: backdrop,
      poster: poster,
      rating: rating == 0 ? null : rating,
      year: year == 0 ? null : year,
      type: type,
      genres: genres.isNotEmpty ? genres : null,
      description: synopsis.isNotEmpty ? synopsis : null,
    );
  }

  Section? _parseHomeRow(Element el) {
    final title = el.querySelector('.gnrd-row-head h2')?.text.trim() ?? '';
    if (title.isEmpty) return null;

    final titleType = _typeFromTitle(title);
    final sectionType = titleType == 'anime' ? 'anime' : titleType == 'series' ? 'series' : 'movies';
    final prefix = titleType == 'anime' ? 'gani_' : titleType == 'series' ? 'gser_' : 'gmov_';

    final items = <MediaItem>[];
    for (final card in el.querySelectorAll('.gnrd-rail > a.gnrd-card')) {
      final item = _parseGnrdCard(card, type: titleType, prefix: prefix);
      if (item != null) items.add(item);
    }
    if (items.isEmpty) return null;

    return Section(
      title: title,
      type: sectionType,
      items: items,
      seeAllRoute: el.querySelector('.gnrd-row-head a.gnrd-viewall')?.attributes['href'] ?? '',
      totalItems: items.length,
    );
  }

  // ── Listados ──────────────────────────────────────────────────────────────

  Future<List<MediaItem>> scrapeList(String kind, {int page = 1}) async {
    final path = page > 1 ? '/ver/$kind?page=$page' : '/ver/$kind';
    final html = await fetchPage(path);
    final doc = html_parser.parse(html);

    final mediaType = kind == 'peliculas' ? 'movie' : kind == 'anime' ? 'anime' : 'series';
    final prefix = kind == 'peliculas' ? 'gmov_' : kind == 'series' ? 'gser_' : 'gani_';

    final items = <MediaItem>[];
    for (final el in doc.querySelectorAll('.gnrd-grid > a.gnrd-card')) {
      final item = _parseGnrdCard(el, type: mediaType, prefix: prefix);
      if (item != null) items.add(item);
    }
    return items;
  }

  // ── Detalle ───────────────────────────────────────────────────────────────

  Future<ContentDetail> scrapeDetail(MediaItem item) async {
    final prefix = item.id.startsWith('gmov_') ? 'gmov_' : item.id.startsWith('gser_') ? 'gser_' : 'gani_';
    final isSeries = prefix != 'gmov_';
    final slug = item.id.substring(prefix.length);

    final html = await fetchPage('/ver/$slug/');
    final doc = html_parser.parse(html);
    if ((doc.body?.text ?? '').trim().length < 200) {
      throw Exception('Detalle inválido para ${item.id}');
    }

    final title = _firstText(doc, '.gnrd-fi-title .gnrd-sr') ??
        _cloneTextWithoutChildren(doc, '.gnrd-fi-title') ??
        doc.querySelector('.gnrd-fi-logo')?.attributes['alt']?.trim() ??
        _firstText(doc, '.gnrd-fi-title');
    if (title == null || title.isEmpty) throw Exception('Detalle sin título para ${item.id}');

    final backdrop = _extractImageUrl(_styleOfDoc(doc, '.gnrd-fi-bg'));
    final poster = doc.querySelector('meta[itemprop="image"]')?.attributes['content'];

    final ratingMeta = doc.querySelector('meta[itemprop="ratingValue"]')?.attributes['content'];
    final rating = ratingMeta != null
        ? (double.tryParse(ratingMeta) ?? 0)
        : (_parseRating(doc.querySelector('.gnrd-m-rating')?.text ?? '') ?? 0);

    final metaSpans = doc
        .querySelectorAll('.gnrd-fi-meta > span:not(.gnrd-m-rating)')
        .map((s) => s.text.trim())
        .toList();
    final year = int.tryParse(metaSpans.isNotEmpty ? metaSpans.first : '') ?? 0;
    final duration = metaSpans.length > 1 ? metaSpans[1] : null;
    final country = metaSpans.length > 2 ? metaSpans[2] : null;

    final genres = doc.querySelectorAll('.gnrd-fi-genres a').map((g) => g.text.trim()).toList();
    final description = _firstText(doc, '#gnrd-syn') ?? title;
    final cast = _parseDetailCast(doc);

    final detail = ContentDetail(
      id: item.id,
      title: title,
      description: description,
      backdrop: backdrop ?? poster,
      poster: poster,
      rating: rating != 0 ? rating : (item.rating ?? 7.0),
      year: year != 0 ? year : (item.year ?? 2024),
      duration: duration,
      country: country,
      genres: genres.isNotEmpty ? genres : const ['Acción'],
      cast: cast.isNotEmpty ? cast : const [CastMember(name: 'Reparto Principal')],
      type: item.type,
    );

    final vars = extractPlayerVars(html);
    if (vars != null && vars.pid != null && vars.tok != null) {
      final player = await _fetchRawPlayer(vars.pid!, vars.tok!, '$_activeBase/ver/$slug/');
      final videos = _toVideoLanguages(player);
      if (videos.isNotEmpty) detail.videos = videos;
      final downloads = _toDownloadLinks(player);
      if (downloads.isNotEmpty) detail.downloads = downloads;
    }

    if (isSeries) {
      final parsed = _parseEpisodes(doc, item.id);
      if (parsed.isNotEmpty) {
        await _fillEpisodeVideos(parsed);
        detail.seasons = _buildSeasons(parsed);
      }
    }
    _info('detalle ${item.id}: "$title" videos=${detail.videos?.length ?? 0} seasons=${detail.seasons?.length ?? 0}');
    return detail;
  }

  Future<Map<String, dynamic>> _fetchRawPlayer(int pid, String tok, String referer) async {
    final url = '$_activeBase/wp-json/gnrd/v1/player?id=$pid&t=${Uri.encodeQueryComponent(tok)}';
    final uri = Uri.parse(url);
    final request = await _client.getUrl(uri);
    request.headers.set(HttpHeaders.userAgentHeader, _defaultUa);
    request.headers.set(HttpHeaders.refererHeader, referer);
    request.headers.set('X-Requested-With', 'XMLHttpRequest');
    request.headers.set(HttpHeaders.acceptHeader, 'application/json');
    final cookie = _cookieHeaderFor(uri.host);
    if (cookie.isNotEmpty) request.headers.set(HttpHeaders.cookieHeader, cookie);
    final response = await request.close().timeout(const Duration(seconds: 15));
    _storeCookies(uri.host, response.headers[HttpHeaders.setCookieHeader] ?? const []);
    final body = await response.transform(utf8.decoder).join().timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) return const {};
    return unpack((jsonDecode(body) as Map<String, dynamic>?)?['p'] as String? ?? '');
  }

  List<({int season, Episode episode, String url})> _parseEpisodes(Document doc, String seriesId) {
    final parsed = <({int season, Episode episode, String url})>[];
    for (final el in doc.querySelectorAll('.gnrd-epc')) {
      final season = int.tryParse(el.attributes['data-s'] ?? '');
      final epNum = int.tryParse(el.attributes['data-e'] ?? '');
      if (season == null || epNum == null) continue;
      final href = el.attributes['href'] ?? '';
      final title = el.querySelector('.gnrd-epc-title')?.text.trim() ?? el.querySelector('.gnrd-epc-n')?.text.trim() ?? '';
      if (title.isEmpty) continue;
      final thumbnail = _extractImageUrl(_styleOf(el, '.gnrd-epc-thumb'));
      final episode = Episode(
        id: '${seriesId}_s${season}e$epNum',
        title: title,
        duration: el.querySelector('.gnrd-epc-dur')?.text.trim() ?? '45m',
        description: el.querySelector('.gnrd-epc-ov')?.text.trim(),
        thumbnail: thumbnail,
        episodeNumber: epNum,
      );
      parsed.add((season: season, episode: episode, url: href));
    }
    return parsed;
  }

  Future<void> _fillEpisodeVideos(List<({int season, Episode episode, String url})> parsed) async {
    final limited = parsed.take(maxEpisodesScrape).toList();
    // Concurrencia 2 + delay: la player API responde 502 si se martilla.
    for (var i = 0; i < limited.length; i += 2) {
      final batch = limited.sublist(i, (i + 2 < limited.length) ? i + 2 : limited.length);
      await Future.wait(batch.map((entry) async {
        try {
          final html = await fetchPage(entry.url);
          final vars = extractPlayerVars(html);
          if (vars == null || vars.pid == null || vars.tok == null) return;
          final videos = await fetchPlayerVideos(pid: vars.pid!, tok: vars.tok!, referer: entry.url);
          if (videos.isNotEmpty) entry.episode.videos = videos;
        } catch (_) {
          // episodio sin player: se omite
        }
      }));
      if (i + 2 < limited.length) {
        await Future<void>.delayed(const Duration(milliseconds: 800));
      }
    }
  }

  List<Season> _buildSeasons(List<({int season, Episode episode, String url})> parsed) {
    final map = <int, List<Episode>>{};
    for (final entry in parsed) {
      map.putIfAbsent(entry.season, () => []).add(entry.episode);
    }
    final keys = map.keys.toList()..sort();
    return keys.map((n) {
      final episodes = map[n]!;
      episodes.sort((a, b) => a.episodeNumber.compareTo(b.episodeNumber));
      return Season(seasonNumber: n, title: 'Temporada $n', episodes: episodes);
    }).toList();
  }

  // ── Cards / helpers de parseo ─────────────────────────────────────────────

  MediaItem? _parseGnrdCard(Element el, {required String type, required String prefix}) {
    final href = el.attributes['href'] ?? '';
    final slug = _extractSlug(href);
    if (slug.isEmpty) return null;

    final badge = el.querySelector('.gnrd-type-badge')?.text.trim().toLowerCase() ?? '';
    String cardType = type;
    if (badge.isNotEmpty) {
      cardType = badge.contains('anime') ? 'anime' : badge.contains('serie') ? 'series' : 'movie';
    }

    final title = el.attributes['title']?.trim() ?? el.querySelector('.gnrd-card-title')?.text.trim() ?? '';
    if (title.isEmpty) return null;

    final poster = el.querySelector('.gnrd-card-art img')?.attributes['src'] ?? el.querySelector('img')?.attributes['src'];
    final rating = _parseRating(el.querySelector('.gnrd-rating')?.text ?? '');
    final yearText = el.querySelector('.gnrd-card-metaline span:last-child')?.text.trim() ?? '';
    final year = int.tryParse(yearText) ?? 0;
    final genresText = el.querySelector('.gnrd-card-genres')?.text.trim() ?? '';

    final item = MediaItem(
      id: '$prefix$slug',
      title: title,
      poster: poster,
      rating: rating == 0 ? null : rating,
      year: year == 0 ? null : year,
      type: cardType,
    );
    if (genresText.isNotEmpty) {
      item.genres = genresText.split(RegExp(r'[•·|]')).map((g) => g.trim()).where((g) => g.isNotEmpty).toList();
    }
    return item;
  }

  List<CastMember> _parseDetailCast(Document doc) {
    try {
      final cast = <CastMember>[];
      for (final el in doc.querySelectorAll('script[type="application/ld+json"]')) {
        final raw = el.text.trim();
        if (raw.isEmpty) continue;
        final data = jsonDecode(raw);
        final graph = data is List ? data : (data is Map ? (data['@graph'] ?? [data]) : const []);
        if (graph is! List) continue;
        for (final node in graph) {
          if (node is! Map) continue;
          final actorRaw = node['actor'];
          final actors = actorRaw is List ? actorRaw : (actorRaw is Map ? [actorRaw] : const []);
          for (final actor in actors) {
            if (actor is! Map) continue;
            final name = actor['name'];
            if (name is! String) continue;
            final character = actor['characterName'] ?? (actor['character'] is Map ? actor['character']['name'] : null);
            cast.add(CastMember(name: name, character: character is String ? character : null));
          }
        }
      }
      return cast.take(15).toList();
    } catch (_) {
      return const [];
    }
  }

  String? _extractImageUrl(String? style) {
    if (style == null) return null;
    final match = RegExp(r'url\((.+?)\)').firstMatch(style);
    if (match == null) return null;
    var url = match.group(1)!.trim();
    while (url.startsWith("'") || url.startsWith('"')) {
      url = url.substring(1);
    }
    while (url.endsWith("'") || url.endsWith('"')) {
      url = url.substring(0, url.length - 1);
    }
    return url.startsWith('http') || url.startsWith('//') ? url : null;
  }

  String _extractSlug(String href) {
    final match = RegExp(r'/ver/([^/]+)/?$').firstMatch(href);
    return match == null ? '' : match.group(1)!;
  }

  String _slugify(String text) {
    return text
        .toLowerCase()
        .replaceAll(RegExp(r'[áàäâ]'), 'a')
        .replaceAll(RegExp(r'[éèëê]'), 'e')
        .replaceAll(RegExp(r'[íìïî]'), 'i')
        .replaceAll(RegExp(r'[óòöô]'), 'o')
        .replaceAll(RegExp(r'[úùüû]'), 'u')
        .replaceAll(RegExp(r'ñ'), 'n')
        .replaceAll(RegExp(r'[^a-z0-9\s-]'), '')
        .trim()
        .replaceAll(RegExp(r'\s+'), '-');
  }

  double? _parseRating(String text) {
    final match = RegExp(r'([\d.]+)').firstMatch(text.replaceAll('★', ''));
    if (match == null) return null;
    final value = double.tryParse(match.group(1)!);
    return value == null || !value.isFinite ? null : value;
  }

  String _typeFromTitle(String title) {
    final t = title.toLowerCase();
    if (t.contains('anime')) return 'anime';
    if (t.contains('serie')) return 'series';
    return 'movie';
  }

  String? _firstText(Document doc, String selector) {
    final text = doc.querySelector(selector)?.text.trim();
    return text != null && text.isNotEmpty ? text : null;
  }

  String? _cloneTextWithoutChildren(Document doc, String selector) {
    final el = doc.querySelector(selector);
    if (el == null) return null;
    final clone = el.clone(false);
    final text = clone.text.trim();
    return text.isEmpty ? null : text;
  }

  String? _styleOf(Element el, String selector) {
    return el.querySelector(selector)?.attributes['style'];
  }

  String? _styleOfDoc(Document doc, String selector) {
    return doc.querySelector(selector)?.attributes['style'];
  }

  Future<void> close() async {
    _client.close(force: true);
  }
}