import 'dart:async';
import 'dart:convert';

import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'sync_runner.dart';

/// Clave donde la UI guarda el comando (`sync`/`keepalive`) que el
/// [SyncTaskHandler] lee al arrancar. Se usa `saveData` porque el isolate del
/// servicio no comparte memoria con el isolate de la UI.
const String syncCommandKey = 'veamos_sync_command';

/// Clave del punto de control para reanudar una sincronización interrumpida.
const String syncCheckpointKey = 'veamos_sync_checkpoint';

/// Id (y por tanto id de la notificación) del foreground service.
const int syncServiceId = 256;

/// Comandos que viajan (JSON) de la UI al [SyncTaskHandler].
String buildSyncCommand({
  required List<SyncTask> tasks,
  required String backendUrl,
  required String token,
  required List<String> domains,
  bool keepAlive = false,
  bool resume = false,
  SyncOptions options = const SyncOptions(),
}) {
  return jsonEncode({
    'command': 'sync',
    'tasks': tasks.map((t) => t.name).toList(),
    'backendUrl': backendUrl,
    'token': token,
    'domains': domains,
    'keepAlive': keepAlive,
    'resume': resume,
    'options': options.toJson(),
  });
}

String buildKeepAliveCommand() => jsonEncode({'command': 'keepalive'});

String buildStopCommand() => jsonEncode({'command': 'stop'});

/// ¿Quedó una sincronización a medias (reanudable con "Continuar")?
Future<bool> hasSyncCheckpoint() async {
  try {
    final raw = await FlutterForegroundTask.getData<String>(key: syncCheckpointKey);
    return raw != null && raw.isNotEmpty;
  } catch (_) {
    return false;
  }
}

/// Punto de entrada que ejecuta el isolate del foreground service. Debe ser
/// top-level y anotado con `@pragma('vm:entry-point')`.
@pragma('vm:entry-point')
void syncTaskCallback() {
  FlutterForegroundTask.setTaskHandler(SyncTaskHandler());
}

/// Punto de control persistido con `flutter_foreground_task` (SharedPreferences),
/// accesible desde el isolate del servicio y desde la UI.
class _TaskSyncCheckpointStore implements SyncCheckpointStore {
  @override
  Future<Map<String, dynamic>?> load() async {
    final raw = await FlutterForegroundTask.getData<String>(key: syncCheckpointKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      return (jsonDecode(raw) as Map).cast<String, dynamic>();
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> save(Map<String, dynamic> checkpoint) =>
      FlutterForegroundTask.saveData(key: syncCheckpointKey, value: jsonEncode(checkpoint));

  @override
  Future<void> clear() => FlutterForegroundTask.removeData(key: syncCheckpointKey);
}

class SyncTaskHandler extends TaskHandler {
  SyncRunner? _runner;
  bool _stopRequested = false;

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    final raw = await FlutterForegroundTask.getData<String>(key: syncCommandKey);
    if (raw != null && raw.isNotEmpty) {
      await _runCommand(raw);
    }
  }

  /// Llega con `FlutterForegroundTask.sendDataToTask` cuando el servicio ya
  /// estaba corriendo (p. ej. modo "mantener activo" y se pide otra sync).
  @override
  void onReceiveData(Object data) {
    if (data is String && data.isNotEmpty) {
      _runCommand(data);
    }
  }

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
    _stopRequested = true;
    await _runner?.close();
    _runner = null;
  }

  Future<void> _runCommand(String raw) async {
    Map<String, dynamic> cmd;
    try {
      cmd = jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return;
    }

    switch (cmd['command']) {
      case 'stop':
        _stopRequested = true;
        return;
      case 'keepalive':
        return;
      case 'sync':
        break;
      default:
        return;
    }

    if (_runner != null) {
      _log('⚠️ Ya hay una sincronización en curso.');
      return;
    }

    _stopRequested = false;
    final keepAlive = cmd['keepAlive'] == true;
    final resume = cmd['resume'] == true;
    final runner = SyncRunner(
      backendUrl: cmd['backendUrl'] as String? ?? '',
      token: cmd['token'] as String? ?? '',
      domains: (cmd['domains'] as List?)?.cast<String>() ?? const [],
      log: _log,
      onProgress: _progress,
      store: _TaskSyncCheckpointStore(),
      shouldStop: () => _stopRequested,
    );
    _runner = runner;

    try {
      await runner.run(
        syncTasksFromNames((cmd['tasks'] as List?)?.cast<String>() ?? const []),
        resume: resume,
        options: SyncOptions.fromJson((cmd['options'] as Map?)?.cast<String, dynamic>()),
      );
      _log('✅ Sincronización terminada.');
      FlutterForegroundTask.sendDataToMain({'kind': 'done'});
    } on TimeoutException {
      _log('❌ Timeout: se puede continuar con el botón «Continuar».');
      FlutterForegroundTask.sendDataToMain({'kind': 'error', 'resumable': true});
    } catch (error) {
      _log('❌ Error: $error');
      FlutterForegroundTask.sendDataToMain({'kind': 'error', 'resumable': false});
    } finally {
      await runner.close();
      _runner = null;
      _stopRequested = false;
      await _finishService(keepAlive);
    }
  }

  Future<void> _finishService(bool keepAlive) async {
    FlutterForegroundTask.sendDataToMain({'kind': 'resumable', 'value': await hasSyncCheckpoint()});
    if (keepAlive) {
      FlutterForegroundTask.sendDataToMain({'kind': 'idle'});
      await FlutterForegroundTask.updateService(
        notificationTitle: 'veamosTVSync activo',
        notificationText: 'En espera de una sincronización',
      );
    } else {
      await FlutterForegroundTask.stopService();
    }
  }

  void _log(String message) {
    FlutterForegroundTask.sendDataToMain({'kind': 'log', 'line': message});
  }

  void _progress(int done, int total, int saved, String step) {
    FlutterForegroundTask.sendDataToMain({
      'kind': 'progress',
      'done': done,
      'total': total,
      'saved': saved,
      'step': step,
    });
    final pct = total > 0 ? (done * 100 ~/ total) : 0;
    FlutterForegroundTask.updateService(
      notificationTitle: 'veamosTVSync — sincronizando',
      notificationText: total > 0 ? '$step ($pct%)' : step,
    );
  }
}
