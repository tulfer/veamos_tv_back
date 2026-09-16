import 'package:flutter_test/flutter_test.dart';

import 'package:veamos_sync/services/doh_resolver.dart';

void main() {
  group('DohResolver.extractAddressesFromRawHttp', () {
    test('extrae registros A y AAAA de una respuesta con Content-Length', () {
      const raw = 'HTTP/1.1 200 OK\r\n'
          'Content-Type: application/dns-json\r\n'
          'Content-Length: 123\r\n'
          '\r\n'
          '{"Status":0,"Answer":['
          '{"name":"ww3.gnulahd.nu","type":1,"TTL":300,"data":"185.178.208.130"},'
          '{"name":"ww3.gnulahd.nu","type":28,"TTL":300,"data":"2001:db8::1"}'
          ']}';
      final result = DohResolver.extractAddressesFromRawHttp(raw);
      expect(result.map((a) => a.address), contains('185.178.208.130'));
      expect(result.map((a) => a.address), contains('2001:db8::1'));
    });

    test('decodifica Transfer-Encoding: chunked (Google)', () {
      // Formato real de dns.google: cada chunk con su tamaño en hex.
      const bodyPlain = '{"Status":0,"Answer":['
          '{"name":"ww3.gnulahd.nu","type":1,"TTL":61,"data":"185.178.208.130"}'
          ']}';
      final chunks = _chunk(bodyPlain);
      final raw = 'HTTP/1.1 200 OK\r\n'
          'Content-Type: application/json; charset=UTF-8\r\n'
          'Transfer-Encoding: chunked\r\n'
          '\r\n'
          '$chunks'
          '0\r\n\r\n';
      final result = DohResolver.extractAddressesFromRawHttp(raw);
      expect(result.map((a) => a.address), contains('185.178.208.130'));
    });

    test('ignora respuestas con Status distinto de 2xx', () {
      final result = DohResolver.extractAddressesFromRawHttp('HTTP/1.1 400 Bad Request\r\n\r\n{}');
      expect(result, isEmpty);
    });

    test('retorna vacío ante JSON inválido o sin Answer', () {
      expect(DohResolver.extractAddressesFromRawHttp('HTTP/1.1 200 OK\r\n\r\n{"Status":2}'), isEmpty);
    });
  });

  test('lookup resuelve por DNS del sistema', () async {
    final resolver = DohResolver();
    final addresses = await resolver.lookup('ww3.gnulahd.nu');
    expect(addresses, isNotEmpty);
    expect(addresses.first.address, isNotEmpty);
  });
}

String _chunk(String data) {
  return '${data.length.toRadixString(16)}\r\n$data\r\n';
}