import 'dart:convert';
import 'dart:io';

import '../models.dart';

/// Cliente del endpoint de ingesta del backend (`POST /sync/ingest`).
/// La app scrapea GNULA y sube aquí; el backend persiste y, si pide `enrich`,
/// mezcla los demás proveedores (que no están bloqueados desde dokploy).

class IngestApi {
  final String baseUrl; // p.ej. https://veamos.example.com
  final String token;
  final HttpClient _client;
  final void Function(String message)? _log;

  IngestApi({required this.baseUrl, required this.token, void Function(String message)? log})
      : _log = log,
        _client = HttpClient()..connectionTimeout = const Duration(seconds: 20);

  String get _ingestUrl => '$baseUrl/sync/ingest';

  Future<Map<String, dynamic>> _post(Map<String, dynamic> body) async {
    final uri = Uri.parse(_ingestUrl);
    final request = await _client.postUrl(uri);
    request.headers.set(HttpHeaders.contentTypeHeader, ContentType.json.mimeType);
    request.headers.set('X-Sync-Token', token);
    request.headers.set(HttpHeaders.acceptHeader, 'application/json');
    request.add(utf8.encode(jsonEncode(body)));

    final response = await request.close().timeout(const Duration(seconds: 180));
    final raw = await response.transform(utf8.decoder).join().timeout(const Duration(seconds: 180));
    if (response.statusCode >= 300) {
      String detail = raw;
      try {
        detail = (jsonDecode(raw) as Map<String, dynamic>)['error'] as String? ?? raw;
      } catch (_) {}
      throw HttpException('HTTP ${response.statusCode}: $detail');
    }
    try {
      return jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return {'ok': true};
    }
  }

  Future<void> sendHome(GnulahdHomeData home) async {
    await _post({'type': 'home', 'home': home.toJson()});
    _log?.call('[ingest] home subido (${home.banners.length} banners, ${home.sections.length} secciones)');
  }

  /// Envía un lote de ítems del catálogo (con su `content` de GNULA ya
  /// scrapeado). Con `replace` el backend reemplaza la colección completa.
  /// Devuelve cuántos guardó el backend.
  Future<int> sendItems(
    String type,
    List<Map<String, dynamic>> items, {
    bool enrich = true,
    bool replace = false,
  }) async {
    if (items.isEmpty) return 0;
    final result = await _post({
      'type': type,
      'items': items,
      'enrich': enrich,
      if (replace) 'replace': true,
    });
    _log?.call('[ingest] $type: ${result['saved'] ?? items.length} items guardados');
    return result['saved'] as int? ?? items.length;
  }

  void close() {
    _client.close(force: true);
  }
}