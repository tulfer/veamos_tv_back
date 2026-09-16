import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Resolver DNS con respaldo DNS-over-HTTPS (DoH).
///
/// Motivo: en Android, Flutter/Dart resuelve DNS con su propio resolver, que no
/// siempre usa el DNS de la red (p.ej. WiFi con "Private DNS" o filtros del
/// proveedor). El navegador sí resuelve porque usa DoH/el resolver del SO.
/// Este resolver consulta varios proveedores DoH por HTTPS usando direcciones
/// IP fijas, por lo que nunca depende del resolver del sistema.
class DohResolver {
  /// (url, ip, host de SNI). Provedores con distintos rangos IP para que el
  /// bloqueo de DNS de una red determinada no tumbe todo el respaldo.
  static const List<({String url, String ip, String sni})> _servers = [
    (url: 'https://cloudflare-dns.com/dns-query', ip: '1.1.1.1', sni: 'cloudflare-dns.com'),
    (url: 'https://cloudflare-dns.com/dns-query', ip: '1.0.0.1', sni: 'cloudflare-dns.com'),
    (url: 'https://dns.google/resolve', ip: '8.8.8.8', sni: 'dns.google'),
    (url: 'https://dns.google/resolve', ip: '8.8.4.4', sni: 'dns.google'),
    (url: 'https://dns.adguard-dns.com/dns-query', ip: '94.140.14.14', sni: 'dns.adguard-dns.com'),
    (url: 'https://dns.adguard-dns.com/dns-query', ip: '94.140.15.15', sni: 'dns.adguard-dns.com'),
    (url: 'https://dns.quad9.net/dns-query', ip: '9.9.9.9', sni: 'dns.quad9.net'),
    (url: 'https://dns.quad9.net/dns-query', ip: '149.112.112.112', sni: 'dns.quad9.net'),
    (url: 'https://doh.opendns.com/dns-query', ip: '208.67.222.222', sni: 'doh.opendns.com'),
    (url: 'https://doh.opendns.com/dns-query', ip: '208.67.220.220', sni: 'doh.opendns.com'),
  ];

  static const Duration _ttl = Duration(minutes: 5);
  static const Duration _connectTimeout = Duration(seconds: 5);
  static const Duration _requestTimeout = Duration(seconds: 10);

  final LogFn? log;
  final Map<String, ({List<InternetAddress> addresses, DateTime expires})> _cache = {};

  DohResolver({this.log});

  /// Resuelve [host]. Intenta el resolver del sistema primero y, si falla,
  /// cae a DNS-over-HTTPS probando todos los proveedores. El error que se lanza
  /// incluye el detalle del último fallo (del sistema o del DoH).
  Future<List<InternetAddress>> lookup(String host) async {
    final cached = _cache[host];
    if (cached != null && cached.expires.isAfter(DateTime.now())) {
      return cached.addresses;
    }

    try {
      final addresses = await InternetAddress.lookup(host).timeout(_connectTimeout);
      if (addresses.isNotEmpty) {
        log?.call('[doh] $host resuelto por el sistema: $addresses');
        _put(host, addresses);
        return addresses;
      }
    } catch (error) {
      log?.call('[doh] $host falló en el sistema: $error');
    }

    final addresses = await resolveDoh(host);
    _put(host, addresses);
    return addresses;
  }

  /// Resolución estrictamente via DoH (diagnóstico y respaldo).
  Future<List<InternetAddress>> resolveDoh(String host) async {
    final errors = <String>[];
    for (final server in _servers) {
      try {
        final addresses = await _queryDoh(server.url, server.ip, server.sni, host);
        if (addresses.isNotEmpty) {
          log?.call('[doh] ${server.sni} resolvió $host: $addresses');
          return addresses;
        }
        errors.add('${server.sni} (${server.ip}): sin registros A/AAAA');
      } catch (error) {
        errors.add('${server.sni} (${server.ip}): $error');
      }
    }
    throw SocketException('DoH agotado para $host. Errores: {${errors.join('; ')}}');
  }

  void _put(String host, List<InternetAddress> addresses) {
    _cache[host] = (addresses: List.of(addresses), expires: DateTime.now().add(_ttl));
  }

  Future<List<InternetAddress>> _queryDoh(String urlStr, String serverIp, String sniHost, String host) async {
    final uri = Uri.parse(urlStr);
    final requestUri = uri.replace(queryParameters: {'name': host, 'type': 'A'});

    Socket? socket;
    SecureSocket? secure;
    try {
      socket = await Socket.connect(InternetAddress(serverIp), 443, timeout: _connectTimeout);
      secure = await SecureSocket.secure(
        socket,
        host: sniHost,
        onBadCertificate: (cert) {
          log?.call('[doh] certificado no válido en $sniHost: ${cert.issuer} -> ${cert.subject}');
          return false;
        },
      ).timeout(_requestTimeout, onTimeout: () => throw const SocketException('Handshake TLS DoH agotado'));

      final header = 'GET ${requestUri.path}?${requestUri.query} HTTP/1.1\r\n'
          'Host: ${uri.host}\r\n'
          'Accept: application/dns-json\r\n'
          'User-Agent: veamosTVSync/1.0\r\n'
          'Connection: close\r\n'
          '\r\n';
      secure.add(const Utf8Encoder().convert(header));
      secure.flush();

      final raw = await _readToClose(secure).timeout(_requestTimeout);
      log?.call('[doh] $sniHost respondió ${raw.length} bytes para $host');
      final addresses = extractAddressesFromRawHttp(raw);
      if (addresses.isEmpty) {
        throw SocketException('DoH $sniHost sin registros A/AAAA para $host');
      }
      return addresses;
    } finally {
      try {
        secure?.destroy();
      } catch (_) {}
      try {
        socket?.destroy();
      } catch (_) {}
    }
  }

  /// Lee todos los bytes hasta EOF (enviamos Connection: close). Algunos DoH
  /// mandan Content-Length y cierran igual; otros usan chunked; se devuelve el
  /// crudo y luego se desglosa la cabecera HTTP.
  Future<String> _readToClose(SecureSocket socket) async {
    final bytes = <int>[];
    await for (final chunk in socket) {
      bytes.addAll(chunk);
      if (bytes.length > (1 << 20)) break; // 1 MiB de techo
    }
    return utf8.decode(bytes, allowMalformed: true);
  }

  /// Separa cabecera/cuerpo, decodifica chunked y extrae los A/AAAA del JSON.
  /// Puerta pública para tests y para detectar respuestas no-200.
  static List<InternetAddress> extractAddressesFromRawHttp(String raw) {
    final split = _splitHttp(raw);
    if (split.status < 200 || split.status >= 300) return const [];
    final body = split.isChunked ? _dechunk(split.body) : split.body;
    return _parseAnswer(body);
  }

  /// Separa cabecera/cuerpo y detecta codificación de transferencia.
  static ({int status, bool isChunked, String body}) _splitHttp(String raw) {
    final headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd < 0) return (status: 0, isChunked: false, body: raw);
    final head = raw.substring(0, headerEnd);
    final body = raw.substring(headerEnd + 4);

    final statusLine = head.split('\r\n').first;
    final statusMatch = RegExp(r'HTTP/\d(?:\.\d)?\s+(\d+)').firstMatch(statusLine);
    final status = statusMatch == null ? 0 : int.tryParse(statusMatch.group(1)!) ?? 0;

    final transferChunked = RegExp(r'transfer-encoding:\s*chunked', caseSensitive: false).hasMatch(head);
    return (status: status, isChunked: transferChunked, body: body);
  }

  /// Decodifica un cuerpo `Transfer-Encoding: chunked` (formato
  /// `<hex>\r\n<data>\r\n...0\r\n\r\n`).
  static String _dechunk(String body) {
    final out = StringBuffer();
    final parts = body.split('\r\n');
    var i = 0;
    while (i < parts.length) {
      final sizeLine = parts[i].trim();
      final size = int.tryParse(sizeLine, radix: 16) ?? -1;
      if (size <= 0) break;
      if (i + 1 >= parts.length) break;
      out.write(parts[i + 1]);
      i += 2;
    }
    return out.toString();
  }

  /// Extrae los registros A/AAAA del cuerpo JSON de DoH.
  static List<InternetAddress> _parseAnswer(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is! Map) return const [];
      final answer = decoded['Answer'];
      if (answer is! List) return const [];

      // 1 = A (IPv4), 28 = AAAA (IPv6)
      final result = <InternetAddress>[];
      for (final entry in answer) {
        if (entry is! Map) continue;
        final type = entry['type'];
        final data = entry['data'];
        if (data is! String || data.isEmpty) continue;
        if (type == 1 || type == 28) {
          try {
            result.add(InternetAddress(data));
          } catch (_) {
            // dirección inválida, se omite
          }
        }
      }
      return result;
    } catch (_) {
      return const <InternetAddress>[];
    }
  }
}

typedef LogFn = void Function(String message);