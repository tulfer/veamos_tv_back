import 'dart:convert';
import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

import 'services/sync_runner.dart';

/// Programación de un trabajo automático ("automático" en la UI).
///
/// `job` es una de: `home`, `movies`, `series`, `anime`. Cuando está
/// [enabled], la app lo corre en segundo plano cada [intervalMinutes]
/// (mínimo 15, que es el piso de WorkManager en Android) usando las
/// opciones [options] (las mismas del modal manual: páginas, reemplazo, content).
class AutoSchedule {
  final String job;
  bool enabled;
  int intervalMinutes;
  SyncOptions options;

  AutoSchedule({
    required this.job,
    this.enabled = false,
    this.intervalMinutes = 240,
    SyncOptions? options,
  }) : options = options ?? const SyncOptions();

  String get label => switch (job) {
        'home' => 'Home GNULA',
        'anime' => 'Home Anime',
        'movies' => 'Películas',
        'series' => 'Series',
        _ => job,
      };

  Map<String, dynamic> toJson() => {
        'enabled': enabled,
        'intervalMinutes': intervalMinutes,
        'options': options.toJson(),
      };

  factory AutoSchedule.fromJson(String job, Map<String, dynamic>? json) {
    if (json == null) return AutoSchedule(job: job);
    final minutes = (json['intervalMinutes'] as num?)?.toInt() ?? 240;
    return AutoSchedule(
      job: job,
      enabled: json['enabled'] == true,
      intervalMinutes: minutes < 15 ? 15 : minutes,
      options: SyncOptions.fromJson((json['options'] as Map?)?.cast<String, dynamic>()),
    );
  }
}

/// Configuración persistida de la app: URL base del backend (de Veamos TV),
/// token de ingesta (`SYNC_INGEST_TOKEN` del servidor), dominios de GNULA,
/// las programaciones automáticas y el id del dispositivo (para FCM).
class AppConfig {
  static const _kBackend = 'backend_url';
  static const _kToken = 'sync_token';
  static const _kGnulaDomains = 'gnula_domains';
  static const _kDeviceId = 'device_id';
  static const _kAutoPrefix = 'auto_schedule_';
  static const _kLastPrefix = 'auto_last_';
  static const List<String> autoJobs = ['home', 'anime', 'movies', 'series'];
  static const List<String> defaultGnulaDomains = [
    'https://ww3.gnulahd.nu',
    'https://gnulahd.click',
    'https://gnulahd.bid',
    'https://gnulahd.nu',
  ];

  String backendUrl = '';
  String syncToken = '';
  List<String> gnulaDomains = defaultGnulaDomains;
  String deviceId = '';
  final Map<String, AutoSchedule> autoSchedules = {};
  final Map<String, int> lastRuns = {};

  final SharedPreferences _prefs;

  AppConfig(this._prefs) {
    backendUrl = _prefs.getString(_kBackend) ?? '';
    syncToken = _prefs.getString(_kToken) ?? '';
    deviceId = _prefs.getString(_kDeviceId) ?? '';
    final domains = _prefs.getString(_kGnulaDomains);
    if (domains != null && domains.isNotEmpty) {
      gnulaDomains = domains.split('\n').map((d) => d.trim()).where((d) => d.isNotEmpty).toList();
    }
    if (gnulaDomains.isEmpty) {
      gnulaDomains = defaultGnulaDomains;
    }
    for (final job in autoJobs) {
      final raw = _prefs.getString('$_kAutoPrefix$job');
      if (raw != null && raw.isNotEmpty) {
        try {
          autoSchedules[job] = AutoSchedule.fromJson(job, (jsonDecode(raw) as Map).cast<String, dynamic>());
          continue;
        } catch (_) {
          // programación corrupta: se restaura al valor por defecto
        }
      }
      autoSchedules[job] = AutoSchedule(job: job);
      lastRuns[job] = _prefs.getInt('$_kLastPrefix$job') ?? 0;
    }
  }

  Future<void> save() async {
    await _prefs.setString(_kBackend, backendUrl.trim());
    await _prefs.setString(_kToken, syncToken.trim());
    await _prefs.setString(_kGnulaDomains, gnulaDomains.join('\n'));
  }

  Future<void> setSchedule(AutoSchedule schedule) async {
    autoSchedules[schedule.job] = schedule;
    await _prefs.setString('$_kAutoPrefix${schedule.job}', jsonEncode(schedule.toJson()));
  }

  Future<void> setLastRun(String job, int millis) async {
    lastRuns[job] = millis;
    await _prefs.setInt('$_kLastPrefix$job', millis);
  }

  /// Id persistente del dispositivo, para registrar el token FCM en el backend.
  Future<String> ensureDeviceId() async {
    if (deviceId.isEmpty) {
      final rnd = Random();
      deviceId = 'vn_${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}_${rnd.nextInt(0x7fffffff).toRadixString(36)}';
      await _prefs.setString(_kDeviceId, deviceId);
    }
    return deviceId;
  }

  bool get isConfigured => backendUrl.trim().isNotEmpty && syncToken.trim().isNotEmpty;

  static Future<AppConfig> load() async {
    final prefs = await SharedPreferences.getInstance();
    return AppConfig(prefs);
  }
}