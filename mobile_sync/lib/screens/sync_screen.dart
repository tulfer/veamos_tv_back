import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../config.dart';
import '../services/sync_runner.dart';
import '../services/sync_task_handler.dart';

/// Pantalla principal de sincronización. La sync se ejecuta dentro de un
/// foreground service (`flutter_foreground_task`) para que Android no mate el
/// proceso cuando la app pasa a segundo plano; la notificación muestra el
/// avance y la UI recibe logs/progreso por el puerto de comunicación.
class SyncScreen extends StatefulWidget {
  final AppConfig config;

  const SyncScreen({super.key, required this.config});

  @override
  State<SyncScreen> createState() => _SyncScreenState();
}

class _SyncScreenState extends State<SyncScreen> {
  final List<String> _log = [];
  final ScrollController _scroll = ScrollController();
  bool _running = false;
  bool _serviceActive = false;
  bool _keepAlive = false;
  bool _resumable = false;
  int _done = 0;
  int _total = 0;
  int _saved = 0;
  String _currentStep = '';

  @override
  void initState() {
    super.initState();
    FlutterForegroundTask.addTaskDataCallback(_onTaskData);
    _refreshServiceState();
    _refreshCheckpoint();
  }

  @override
  void dispose() {
    FlutterForegroundTask.removeTaskDataCallback(_onTaskData);
    WakelockPlus.disable();
    _scroll.dispose();
    super.dispose();
  }

  /// Mientras la sync corre y la app está abierta, mantiene la pantalla
  /// encendida (el foreground service ya mantiene la CPU, esto evita que se
  /// apague la pantalla del usuario).
  Future<void> _updateWakelock(bool keepScreenOn) async {
    try {
      if (keepScreenOn) {
        await WakelockPlus.enable();
      } else {
        await WakelockPlus.disable();
      }
    } catch (_) {
      // Sin plataforma (tests): se ignora.
    }
  }

  void _append(String line) {
    _log.add('${_timeStamp()} $line');
    if (_log.length > 500) _log.removeRange(0, _log.length - 500);
    if (mounted) setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 150), curve: Curves.easeOut);
      }
    });
  }

  String _timeStamp() {
    final now = DateTime.now();
    final h = now.hour.toString().padLeft(2, '0');
    final m = now.minute.toString().padLeft(2, '0');
    final s = now.second.toString().padLeft(2, '0');
    return '$h:$m:$s';
  }

  Future<void> _refreshServiceState() async {
    bool running = false;
    try {
      running = await FlutterForegroundTask.isRunningService;
    } catch (_) {
      // Sin plataforma (tests) o servicio no inicializado: se asume apagado.
    }
    if (mounted) setState(() => _serviceActive = running);
  }

  Future<void> _refreshCheckpoint() async {
    final resumable = await hasSyncCheckpoint();
    if (mounted) setState(() => _resumable = resumable);
  }

  /// Datos que envía el isolate del [SyncTaskHandler] (log, progreso, fin).
  void _onTaskData(Object data) {
    if (data is! Map) return;
    switch (data['kind']) {
      case 'log':
        _append(data['line'] as String? ?? '');
        break;
      case 'progress':
        setState(() {
          _running = true;
          _done = data['done'] as int? ?? 0;
          _total = data['total'] as int? ?? 0;
          _saved = data['saved'] as int? ?? 0;
          _currentStep = data['step'] as String? ?? '';
        });
        _updateWakelock(true);
        break;
      case 'done':
      case 'idle':
      case 'error':
        setState(() {
          _running = false;
          _currentStep = '';
        });
        _updateWakelock(false);
        _refreshServiceState();
        _refreshCheckpoint();
        break;
      case 'resumable':
        setState(() => _resumable = data['value'] == true);
        break;
    }
  }

  Future<bool> _ensureNotificationPermission() async {
    final current = await FlutterForegroundTask.checkNotificationPermission();
    if (current == NotificationPermission.granted) return true;
    final result = await FlutterForegroundTask.requestNotificationPermission();
    if (result != NotificationPermission.granted) {
      _append('⚠️ Sin permiso de notificaciones: Android podría detener la sync en segundo plano.');
      return false;
    }
    return true;
  }

  Future<void> _run(List<SyncTask> tasks, {bool resume = false, SyncOptions? options}) async {
    if (!widget.config.isConfigured) {
      _append('❌ Configura la URL del backend y el token en Ajustes.');
      return;
    }
    if (_running) return;

    await _ensureNotificationPermission();

    setState(() {
      _running = true;
      _done = 0;
      _total = 0;
      _saved = 0;
      _currentStep = 'Iniciando...';
      if (!resume) _log.clear();
    });
    _updateWakelock(true);

    final command = buildSyncCommand(
      tasks: tasks,
      backendUrl: widget.config.backendUrl.trim(),
      token: widget.config.syncToken.trim(),
      domains: widget.config.gnulaDomains,
      keepAlive: _keepAlive,
      resume: resume,
      options: options ?? const SyncOptions(),
    );

    // Si el servicio ya está vivo (modo "mantener activo"), sólo le mandamos
    // el comando por el canal de comunicación.
    if (await FlutterForegroundTask.isRunningService) {
      FlutterForegroundTask.sendDataToTask(command);
      setState(() => _serviceActive = true);
      return;
    }

    await FlutterForegroundTask.saveData(key: syncCommandKey, value: command);
    final result = await FlutterForegroundTask.startService(
      serviceId: syncServiceId,
      serviceTypes: const [ForegroundServiceTypes.dataSync],
      notificationTitle: 'veamosTVSync — sincronizando',
      notificationText: 'Iniciando...',
      callback: syncTaskCallback,
    );
    if (result is ServiceRequestFailure) {
      _append('❌ No se pudo iniciar el servicio: ${result.error}');
      setState(() {
        _running = false;
        _currentStep = '';
      });
      _updateWakelock(false);
      return;
    }
    setState(() => _serviceActive = true);
  }

  /// Pregunta cuántas páginas listar, si reemplaza el catálogo y si carga el
  /// `content` de cada ítem. Devuelve `null` si el usuario cancela.
  Future<SyncOptions?> _askOptions(String label) async {
    var pages = 1;
    var replace = false;
    var fetchContent = true;
    return showDialog<SyncOptions>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(label),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Páginas a listar: $pages  (≈ ${pages * 32} ítems)'),
                Slider(
                  value: pages.toDouble(),
                  min: 1,
                  max: SyncOptions.maxPages.toDouble(),
                  divisions: SyncOptions.maxPages - 1,
                  label: '$pages',
                  onChanged: (value) => setDialogState(() => pages = value.round()),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: replace,
                  onChanged: (value) => setDialogState(() => replace = value),
                  title: const Text('Reemplazar el contenido'),
                  subtitle: const Text('La colección queda solo con lo que venga en el listado'),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: fetchContent,
                  onChanged: (value) => setDialogState(() => fetchContent = value),
                  title: const Text('Cargar el content de cada ítem'),
                  subtitle: const Text('Scrapea el detalle (lento) y lo sube enriquecido'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Cancelar'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(
                dialogContext,
                SyncOptions(pages: pages, replace: replace, fetchContent: fetchContent),
              ),
              child: const Text('Iniciar'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _runKind(SyncTask task, String label) async {
    if (_running) return;
    final options = await _askOptions(label);
    if (options == null) return;
    await _run([task], options: options);
  }

  /// Mantiene el servicio vivo aunque no haya una sync en curso (evita que el
  /// sistema mate el proceso). Si se apaga y no hay sync, detiene el servicio.
  Future<void> _setKeepAlive(bool value) async {
    setState(() => _keepAlive = value);
    if (!value) {
      if (!_running && await FlutterForegroundTask.isRunningService) {
        await FlutterForegroundTask.stopService();
        setState(() => _serviceActive = false);
      }
      return;
    }

    await _ensureNotificationPermission();
    if (await FlutterForegroundTask.isRunningService) return;

    await FlutterForegroundTask.saveData(key: syncCommandKey, value: buildKeepAliveCommand());
    final result = await FlutterForegroundTask.startService(
      serviceId: syncServiceId,
      serviceTypes: const [ForegroundServiceTypes.dataSync],
      notificationTitle: 'veamosTVSync activo',
      notificationText: 'En espera de una sincronización',
      callback: syncTaskCallback,
    );
    if (result is ServiceRequestFailure) {
      _append('❌ No se pudo iniciar el servicio: ${result.error}');
      setState(() => _keepAlive = false);
      return;
    }
    setState(() => _serviceActive = true);
  }

  Future<void> _stop() async {
    if (await FlutterForegroundTask.isRunningService) {
      FlutterForegroundTask.sendDataToTask(buildStopCommand());
      await FlutterForegroundTask.stopService();
    }
    setState(() {
      _running = false;
      _serviceActive = false;
      _keepAlive = false;
      _currentStep = '';
    });
    _updateWakelock(false);
    _append('Servicio en segundo plano detenido.');
    _refreshCheckpoint();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('veamosTVSync'),
        leading: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 0, 8),
          child: Image.asset('assets/icons/app_icon.png'),
        ),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Esta app scrapea GNULA HD desde la IP residencial de tu celular y sube los datos al backend de Veamos TV.',
                  style: theme.textTheme.bodyMedium,
                ),
                const SizedBox(height: 8),
                if (!widget.config.isConfigured)
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.errorContainer,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      '⚠️ Configura la URL y el token del backend en Ajustes.',
                      style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onErrorContainer),
                    ),
                  ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    FilledButton.icon(
                      onPressed: _running ? null : () => _run(const [SyncTask.all]),
                      icon: const Icon(Icons.sync),
                      label: const Text('Sync completo'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _running ? null : () => _run(const [SyncTask.home]),
                      icon: const Icon(Icons.home),
                      label: const Text('Solo home'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _running ? null : () => _runKind(SyncTask.movies, 'Películas'),
                      icon: const Icon(Icons.movie),
                      label: const Text('Películas'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _running ? null : () => _runKind(SyncTask.series, 'Series'),
                      icon: const Icon(Icons.live_tv),
                      label: const Text('Series'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _running ? null : () => _runKind(SyncTask.anime, 'Anime'),
                      icon: const Icon(Icons.animation),
                      label: const Text('Anime'),
                    ),
                  ],
                ),
                if (_resumable)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: FilledButton.icon(
                      onPressed: _running ? null : () => _run(const [], resume: true),
                      icon: const Icon(Icons.play_arrow),
                      label: const Text('Continuar donde quedó'),
                    ),
                  ),
                const SizedBox(height: 4),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: _keepAlive,
                  onChanged: _setKeepAlive,
                  title: const Text('Mantener activo en segundo plano'),
                  subtitle: const Text('Notificación fija para que Android no mate el proceso'),
                ),
                if (_serviceActive)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: _stop,
                      icon: const Icon(Icons.stop_circle_outlined, size: 18),
                      label: const Text('Detener servicio'),
                    ),
                  ),
                if (_running) ...[
                  const SizedBox(height: 8),
                  LinearProgressIndicator(value: _total > 0 ? _done / _total : null),
                  const SizedBox(height: 8),
                  Text(_currentStep, style: theme.textTheme.bodySmall),
                  Text('$_done/$_total detalles · $_saved guardados', style: theme.textTheme.bodySmall),
                ],
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(child: _buildLog(theme)),
        ],
      ),
    );
  }

  Widget _buildLog(ThemeData theme) {
    if (_log.isEmpty) {
      return Center(
        child: Text('El log aparecerá aquí.',
            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline)),
      );
    }
    return Column(
      children: [
        Align(
          alignment: Alignment.centerRight,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: TextButton.icon(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: _log.join('\n')));
                if (mounted) {
                  ScaffoldMessenger.of(context)
                      .showSnackBar(const SnackBar(content: Text('Log copiado al portapapeles')));
                }
              },
              icon: const Icon(Icons.copy, size: 18),
              label: const Text('Copiar log'),
            ),
          ),
        ),
        Expanded(
          child: ListView.builder(
            controller: _scroll,
            padding: const EdgeInsets.all(12),
            itemCount: _log.length,
            itemBuilder: (context, index) => SelectableText(_log[index],
                style: theme.textTheme.bodySmall),
          ),
        ),
      ],
    );
  }
}
