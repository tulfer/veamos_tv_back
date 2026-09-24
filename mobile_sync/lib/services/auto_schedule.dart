import 'package:shared_preferences/shared_preferences.dart';
import 'package:workmanager/workmanager.dart';

import '../config.dart';
import 'notifications.dart';
import 'sync_runner.dart';

/// Nombre único de la tarea periódica de WorkManager (Android). En iOS no
/// aplica (ver README: límites de los BackgroundTasks de 30 s).
const String periodicTaskName = 'veamosAutoSync';

/// Callback que ejecuta WorkManager en segundo plano cuando la app está
/// cerrada o en background (Android). Debe ser top-level y anotado.
@pragma('vm:entry-point')
void autoSyncCallbackDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    try {
      await runDueSchedules();
    } catch (error) {
      // ignore: avoid_print
      print('[auto-sync] fallo en el callback: $error');
    }
    return true;
  });
}

/// (Re)registra la tarea periódica según las programaciones habilitadas del
/// usuario. Si ninguna está activa se cancela la tarea existente.
Future<void> registerAutoSync() async {
  final config = await AppConfig.load();
  final enabled = config.autoSchedules.values.where((s) => s.enabled).toList();

  if (enabled.isEmpty) {
    await Workmanager().cancelByUniqueName(periodicTaskName);
    return;
  }

  var minMinutes = enabled.first.intervalMinutes;
  for (final s in enabled) {
    if (s.intervalMinutes < minMinutes) minMinutes = s.intervalMinutes;
  }
  if (minMinutes < 15) minMinutes = 15;

  await Workmanager().registerPeriodicTask(
    periodicTaskName,
    periodicTaskName,
    frequency: Duration(minutes: minMinutes),
    initialDelay: Duration(minutes: minMinutes < 60 ? 15 : 30),
    existingWorkPolicy: ExistingPeriodicWorkPolicy.update,
    constraints: Constraints(networkType: NetworkType.connected),
  );
}

/// Corre los trabajos cuyo intervalo ya venció. Se invoca desde el callback
/// de WorkManager; cada "job" (home/movies/series/anime) usa las opciones que
/// el usuario eligió en su modal (páginas, reemplazo, content).
Future<void> runDueSchedules() async {
  final config = await AppConfig.load();
  if (!config.isConfigured) return;

  final prefs = await SharedPreferences.getInstance();
  await initNotifications();

  final now = DateTime.now().millisecondsSinceEpoch;
  var done = 0;
  var failed = 0;

  for (final job in config.autoJobs) {
    final schedule = config.autoSchedules[job];
    if (schedule == null || !schedule.enabled) continue;

    final lastRun = config.lastRuns[job] ?? 0;
    if (now - lastRun < schedule.intervalMinutes * 60000) continue;
    if (prefs.getBool('auto_running_$job') == true) continue;

    await prefs.setBool('auto_running_$job', true);
    try {
      final summary = await _runJob(config, schedule);
      await config.setLastRun(job, now);
      done++;
      if (summary != null) {
        await showNotification(
          id: 300 + config.autoJobs.indexOf(job),
          title: 'veamosTVSync',
          body: summary,
        );
      }
    } catch (error) {
      failed++;
      // ignore: avoid_print
      print('[auto-sync] $job falló: $error');
      await showNotification(
        id: 310 + config.autoJobs.indexOf(job),
        title: 'veamosTVSync',
        body: '$job: falló la sincronización automática ($error)',
      );
    } finally {
      await prefs.setBool('auto_running_$job', false);
    }
  }

  if (done > 0) {
    // ignore: avoid_print
    print('[auto-sync] $done trabajos listos, $failed con errores.');
  }
}

Future<String?> _runJob(AppConfig config, AutoSchedule schedule) async {
  final tasks = switch (schedule.job) {
    'home' => const [SyncTask.home],
    'movies' => const [SyncTask.movies],
    'series' => const [SyncTask.series],
    _ => const [SyncTask.anime],
  };

  final runner = SyncRunner(
    backendUrl: config.backendUrl.trim(),
    token: config.syncToken.trim(),
    domains: config.gnulaDomains,
    log: (message) {
      // En background no hay log de la UI; la notificación final resume.
      // ignore: avoid_print
      print('[auto-sync:${schedule.job}] $message');
    },
    onProgress: (done, total, saved, step) {
      // Sin UI: se ignora el progreso, solo importa el resultado.
      // ignore: avoid_print
      print('[auto-sync:${schedule.job}] $step');
    },
  );

  try {
    await runner.run(tasks, options: schedule.options);
    return '${schedule.label}: sincronización automática completada.';
  } finally {
    await runner.close();
  }
}