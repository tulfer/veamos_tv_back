import 'package:shared_preferences/shared_preferences.dart';

/// Configuración persistida de la app: URL base del backend (de Veamos TV) y
/// token de ingesta (SYNC_INGEST_TOKEN del servidor).
class AppConfig {
  static const _kBackend = 'backend_url';
  static const _kToken = 'sync_token';
  static const _kGnulaDomains = 'gnula_domains';

  String backendUrl = '';
  String syncToken = '';
  List<String> gnulaDomains = const ['https://ww3.gnulahd.nu', 'https://gnulahd.nu', 'https://gnulahd.click'];

  final SharedPreferences _prefs;

  AppConfig(this._prefs) {
    backendUrl = _prefs.getString(_kBackend) ?? '';
    syncToken = _prefs.getString(_kToken) ?? '';
    final domains = _prefs.getString(_kGnulaDomains);
    if (domains != null && domains.isNotEmpty) {
      gnulaDomains = domains.split('\n').map((d) => d.trim()).where((d) => d.isNotEmpty).toList();
    }
    if (gnulaDomains.isEmpty) {
      gnulaDomains = const ['https://ww3.gnulahd.nu', 'https://gnulahd.nu', 'https://gnulahd.click'];
    }
  }

  Future<void> save() async {
    await _prefs.setString(_kBackend, backendUrl.trim());
    await _prefs.setString(_kToken, syncToken.trim());
    await _prefs.setString(_kGnulaDomains, gnulaDomains.join('\n'));
  }

  bool get isConfigured => backendUrl.trim().isNotEmpty && syncToken.trim().isNotEmpty;

  static Future<AppConfig> load() async {
    final prefs = await SharedPreferences.getInstance();
    return AppConfig(prefs);
  }
}