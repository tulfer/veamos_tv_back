import 'dart:convert';
import 'dart:io';

import 'package:firebase_messaging/firebase_messaging.dart';

import '../config.dart';
import '../models.dart';
import 'gnula_client.dart';
import 'ingest_api.dart';
import 'notifications.dart';

/// kind de los mensajes push data-only que manda el backend.
const String pushTaskKind = 'veamos_sync_task';

/// Callback que ejecuta FCM cuando el mensaje llega con la app muerta o en
/// segundo plano (Android: isolate propio). Debe ser top-level y anotado.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  try {
    await executePushTask(message.data);
  } catch (_) {
    // Sin permisos/plugins en el isolate: no debe tumbar el handler.
  }
}

/// Ejecuta una tarea push. Se llama desde el handler de background y desde el
/// listener de foreground (`FirebaseMessaging.onMessage`).
Future<void> executePushTask(Map<String, dynamic> data) async {
  if (data['kind'] != pushTaskKind) return;
  final task = data['task'] as String?;
  if (task == null || task.isEmpty) return;

  final config = await AppConfig.load();
  if (!config.isConfigured) {
    _logPush('Sin configuración (URL/token); se ignora la tarea "$task".');
    return;
  }

  await initNotifications();

  try {
    final summary = await runPushTask(config, task, data);
    if (summary != null) {
      await showNotification(
        id: 400,
        title: 'veamosTVSync',
        body: summary,
      );
    }
  } catch (error) {
    _logPush('Error en tarea push "$task": $error');
    await showNotification(id: 401, title: 'veamosTVSync', body: 'Push "$task" falló: $error');
  }
}

/// Hace el trabajo del push: scrapea GNULA desde el celular y sube el
/// resultado al backend para que se re-disponga del contenido sin que el
/// servidor necesite acceder a GNULA.
Future<String?> runPushTask(AppConfig config, String task, Map<String, dynamic> data) async {
  final client = GnulaClient(staticDomains: config.gnulaDomains, log: _logPush);
  final api = IngestApi(baseUrl: config.backendUrl.trim(), token: config.syncToken.trim(), log: _logPush);
  try {
    if (task == 'content') {
      final id = (data['id'] ?? '').toString().trim();
      if (id.isEmpty) return 'Contenido sin id; ignorado.';
      final isAnime = id.startsWith('gani_');
      final isSeries = isAnime || id.startsWith('gser_');
      final type = isAnime ? 'anime' : isSeries ? 'series' : 'movie';
      final item = MediaItem(id: id, title: id, type: type);
      _logPush('Push content: scrapeando $id…');
      final detail = await client.scrapeDetail(item);
      final saved = await api.sendItems(
        _collectionForType(type),
        [
          {
            ...item.toCatalogJson(),
            'content': detail.toJson(),
            'contentUpdatedAt': DateTime.now().millisecondsSinceEpoch,
          }
        ],
        enrich: true,
      );
      _logPush('Push content: "$detail.title" subido ($saved).');
      return 'Contenido "$detail.title" scrapeado y subido.';
    }

    if (task == 'search') {
      final query = (data['query'] ?? '').toString().trim();
      if (query.length < 2) return 'Búsqueda inválida; ignorada.';
      _logPush('Push search: buscando "$query"…');
      final items = await client.search(query);
      if (items.isEmpty) return 'Sin resultados para "$query" en GNULA.';
      final saved = await api.sendSearch(query, items.map((i) => i.toCatalogJson()).toList());
      _logPush('Push search: ${items.length} ítems subidos ($saved).');
      return 'Búsqueda "$query": ${items.length} ítems subidos.';
    }

    return null;
  } finally {
    await client.close();
    api.close();
  }
}

String _collectionForType(String type) =>
    type == 'movie' ? 'movies' : (type == 'anime' ? 'anime' : 'series');

/// Registra el token FCM del dispositivo en el backend
/// (`POST /sync/push/register`, auth por `X-Sync-Token`).
Future<void> registerFcmToken(AppConfig config) async {
  if (!config.isConfigured) return;
  final messaging = FirebaseMessaging.instance;
  try {
    await messaging.requestPermission();
  } catch (_) {}

  String? token;
  try {
    token = await messaging.getToken();
  } catch (_) {
    // Aún no hay configuración de Firebase (falta google-services.json).
  }
  final deviceId = await config.ensureDeviceId();
  if (token == null || token.isEmpty) return;

  final body = jsonEncode({
    'deviceId': deviceId,
    'token': token,
    'platform': Platform.isIOS ? 'ios' : 'android',
  });

  final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
  try {
    final request = await client.postUrl(Uri.parse('${config.backendUrl.trim()}/sync/push/register'));
    request.headers.set(HttpHeaders.contentTypeHeader, ContentType.json.mimeType);
    request.headers.set('X-Sync-Token', config.syncToken.trim());
    request.add(utf8.encode(body));
    final response = await request.close().timeout(const Duration(seconds: 30));
    final raw = await response.transform(utf8.decoder).join();
    if (response.statusCode >= 300) {
      _logPush('Registro FCM rechazado (HTTP ${response.statusCode}): $raw');
    } else {
      _logPush('Token FCM registrado ($deviceId).');
    }
  } catch (error) {
    _logPush('No se pudo registrar el token FCM: $error');
  } finally {
    client.close(force: true);
  }
}

void _logPush(String message) {
  // En background no hay log de la UI; print queda en el logcat/console.
  // ignore: avoid_print
  print('[push] $message');
}