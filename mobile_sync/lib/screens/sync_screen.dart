import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../config.dart';
import '../services/auto_schedule.dart';
import '../services/sync_runner.dart';
import '../services/sync_task_handler.dart';

/// Pantalla principal de sincronización de Veamos TV.
/// Ejecuta la sincronización de GNULA y Anime (JKAnime + Latanime)
/// mostrando los registros en tiempo real en pantalla y manteniendo
/// el proceso vivo mediante un Foreground Service de Android.
class SyncScreen extends StatefulWidget {
  final AppConfig config;
  final VoidCallback? onOpenSettings;

  const SyncScreen({
    super.key,
    required this.config,
    this.onOpenSettings,
  });

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
  bool _stopRequested = false;
  SyncRunner? _activeRunner;
  int _done = 0;
  int _total = 0;
  int _saved = 0;
  String _currentStep = '';
  Timer? _autoCheckTimer;

  @override
  void initState() {
    super.initState();
    _refreshServiceState();
    _refreshCheckpoint();
    _autoCheckTimer = Timer.periodic(const Duration(seconds: 30), (_) => _checkAutoDueSchedules());
  }

  @override
  void dispose() {
    _autoCheckTimer?.cancel();
    _autoCheckTimer = null;
    _stopRequested = true;
    _activeRunner?.close();
    _activeRunner = null;
    WakelockPlus.disable();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _checkAutoDueSchedules() async {
    if (_running || !widget.config.isConfigured) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final job in AppConfig.autoJobs) {
      final schedule = widget.config.autoSchedules[job];
      if (schedule == null || !schedule.enabled) continue;
      final lastRun = widget.config.lastRuns[job] ?? 0;
      if (now - lastRun >= schedule.intervalMinutes * 60000) {
        _append('⏰ [Automático] Iniciando sincronización de ${schedule.label}...');
        await widget.config.setLastRun(job, now);
        final tasks = switch (schedule.job) {
          'home' => const [SyncTask.home],
          'anime' => const [SyncTask.anime],
          'movies' => const [SyncTask.movies],
          'series' => const [SyncTask.series],
          _ => const [SyncTask.home],
        };
        await _run(tasks, options: schedule.options);
        break; // Ejecutar una tarea a la vez
      }
    }
  }

  Future<void> _updateWakelock(bool keepScreenOn) async {
    try {
      if (keepScreenOn) {
        await WakelockPlus.enable();
      } else {
        await WakelockPlus.disable();
      }
    } catch (_) {
      // Ignorado si la plataforma no soporta wakelock
    }
  }

  void _append(String line) {
    final formatted = '${_timeStamp()} $line';
    // ignore: avoid_print
    print('[_SyncScreen] $formatted');
    _log.add(formatted);
    if (_log.length > 1000) _log.removeRange(0, _log.length - 1000);
    if (mounted) setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOut,
        );
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
    } catch (_) {}
    if (mounted) setState(() => _serviceActive = running);
  }

  Future<void> _refreshCheckpoint() async {
    final resumable = await hasSyncCheckpoint();
    if (mounted) setState(() => _resumable = resumable);
  }

  Future<bool> _ensureNotificationPermission() async {
    try {
      final current = await FlutterForegroundTask.checkNotificationPermission();
      if (current == NotificationPermission.granted) return true;
      final result = await FlutterForegroundTask.requestNotificationPermission();
      if (result != NotificationPermission.granted) {
        _append('⚠️ Sin permiso de notificaciones: Android podría suspender la app en segundo plano.');
        return false;
      }
      return true;
    } catch (_) {
      return true;
    }
  }

  Future<void> _run(List<SyncTask> tasks, {bool resume = false, SyncOptions? options}) async {
    if (!widget.config.isConfigured) {
      _append('❌ Configura la URL del backend y el token en la pestaña Ajustes.');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text('⚠️ Configura la URL del backend y el token en Ajustes.'),
            action: widget.onOpenSettings != null
                ? SnackBarAction(
                    label: 'Ir a Ajustes',
                    onPressed: widget.onOpenSettings!,
                  )
                : null,
            duration: const Duration(seconds: 4),
          ),
        );
      }
      return;
    }
    if (_running) return;

    await _ensureNotificationPermission();

    setState(() {
      _running = true;
      _stopRequested = false;
      _done = 0;
      _total = 0;
      _saved = 0;
      _currentStep = 'Iniciando sincronización...';
      if (!resume) _log.clear();
    });
    _updateWakelock(true);

    final isAnime = tasks.contains(SyncTask.anime);
    final taskName = isAnime
        ? 'Anime (JKAnime + Latanime)'
        : tasks.map((t) => t.name).join(', ');
    _append('▶ Sincronización iniciada: $taskName');

    // Iniciar Foreground Service de Android para mantener el proceso vivo
    // y mostrar el progreso en la barra de notificaciones del sistema.
    try {
      if (!await FlutterForegroundTask.isRunningService) {
        await FlutterForegroundTask.startService(
          serviceId: syncServiceId,
          serviceTypes: const [ForegroundServiceTypes.dataSync],
          notificationTitle: 'veamosTVSync — sincronizando',
          notificationText: 'Iniciando $taskName...',
        );
      } else {
        await FlutterForegroundTask.updateService(
          notificationTitle: 'veamosTVSync — sincronizando',
          notificationText: 'Iniciando $taskName...',
        );
      }
      setState(() => _serviceActive = true);
    } catch (e) {
      _append('⚠️ Aviso del servicio en segundo plano: $e');
    }

    final effectiveOptions = options ?? const SyncOptions(pages: 5);

    final runner = SyncRunner(
      backendUrl: widget.config.backendUrl.trim(),
      token: widget.config.syncToken.trim(),
      domains: widget.config.gnulaDomains,
      log: (line) => _append(line),
      onProgress: (done, total, saved, step) {
        if (!mounted) return;
        setState(() {
          _done = done;
          _total = total;
          _saved = saved;
          _currentStep = step;
        });
        final pct = total > 0 ? (done * 100 ~/ total) : 0;
        FlutterForegroundTask.updateService(
          notificationTitle: 'veamosTVSync — sincronizando',
          notificationText: total > 0 ? '$step ($pct%)' : step,
        );
      },
      store: TaskSyncCheckpointStore(),
      shouldStop: () => _stopRequested,
    );
    _activeRunner = runner;

    try {
      await runner.run(tasks, resume: resume, options: effectiveOptions);
      _append('✅ Sincronización completada exitosamente.');
    } on TimeoutException {
      _append('❌ Timeout de conexión: puedes reintentar con el botón «Continuar».');
    } catch (error, stack) {
      _append('❌ Error: $error');
      // ignore: avoid_print
      print('[_SyncScreen] Detalle del error: $error\n$stack');
    } finally {
      await runner.close();
      _activeRunner = null;
      _stopRequested = false;
      if (mounted) {
        setState(() {
          _running = false;
          _currentStep = '';
        });
      }
      _updateWakelock(false);
      await _refreshCheckpoint();

      if (!_keepAlive) {
        try {
          await FlutterForegroundTask.stopService();
          if (mounted) setState(() => _serviceActive = false);
        } catch (_) {}
      } else {
        FlutterForegroundTask.updateService(
          notificationTitle: 'veamosTVSync activo',
          notificationText: 'En espera de una sincronización',
        );
      }
    }
  }

  Future<void> _stop() async {
    _stopRequested = true;
    _append('⏹️ Cancelando sincronización...');
    if (_activeRunner != null) {
      await _activeRunner!.close();
      _activeRunner = null;
    }
    if (await FlutterForegroundTask.isRunningService) {
      await FlutterForegroundTask.stopService();
    }
    setState(() {
      _running = false;
      _serviceActive = false;
      _keepAlive = false;
      _currentStep = '';
    });
    _updateWakelock(false);
    _refreshCheckpoint();
  }

  Future<SyncOptions?> _askOptions(String label, {String confirmLabel = 'Iniciar'}) async {
    var pages = 1;
    var replace = false;
    var fetchContent = true;
    var updateExisting = false;
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
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: updateExisting,
                  onChanged: (value) => setDialogState(() {
                    updateExisting = value;
                    if (value) {
                      replace = false;
                      fetchContent = true;
                    }
                  }),
                  title: const Text('Solo actualizar el content de lo ya guardado'),
                  subtitle: const Text('No lista páginas ni agrega títulos: rescrapea el detalle de lo existente'),
                ),
                const Divider(height: 12),
                Text(
                  updateExisting
                      ? 'Se actualizarán los ítems existentes en el backend.'
                      : 'Páginas a listar: $pages  (≈ ${pages * 32} ítems)',
                ),
                Slider(
                  value: pages.toDouble(),
                  min: 1,
                  max: SyncOptions.maxPages.toDouble(),
                  divisions: SyncOptions.maxPages - 1,
                  label: '$pages',
                  onChanged: updateExisting
                      ? null
                      : (value) => setDialogState(() => pages = value.round()),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: replace,
                  onChanged: updateExisting
                      ? null
                      : (value) => setDialogState(() => replace = value),
                  title: const Text('Reemplazar el contenido'),
                  subtitle: const Text('La colección queda solo con lo que venga en el listado'),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: fetchContent,
                  onChanged: updateExisting
                      ? null
                      : (value) => setDialogState(() => fetchContent = value),
                  title: const Text('Cargar el content de cada ítem'),
                  subtitle: const Text('Scrapea el detalle de cada título'),
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
                SyncOptions(
                  pages: pages,
                  replace: replace,
                  fetchContent: updateExisting ? true : fetchContent,
                  updateExisting: updateExisting,
                ),
              ),
              child: Text(confirmLabel),
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

  Future<({SyncOptions options, int intervalMinutes})?> _scheduleDialog(AutoSchedule schedule) async {
    var minutes = schedule.intervalMinutes;
    var pages = schedule.options.pages;
    var replace = schedule.options.replace;
    var fetchContent = schedule.options.fetchContent;
    var updateExisting = schedule.options.updateExisting;
    const intervals = {15, 30, 60, 120, 240, 360, 720, 1440};
    if (!intervals.contains(minutes)) minutes = 240;

    final isAnime = schedule.job == 'anime';
    final isHome = schedule.job == 'home';

    return showDialog<({SyncOptions options, int intervalMinutes})>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text('Automático · ${schedule.label}'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Frecuencia en segundo plano:'),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    for (final m in intervals)
                      ChoiceChip(
                        label: Text(m < 60 ? '$m min' : m % 1440 == 0 ? '1 día' : '${m ~/ 60} h'),
                        selected: minutes == m,
                        onSelected: (_) => setDialogState(() => minutes = m),
                      ),
                  ],
                ),
                const Divider(height: 16),
                if (isAnime) ...[
                  Text('Páginas del directorio a escanear: $pages'),
                  Slider(
                    value: pages.toDouble(),
                    min: 1,
                    max: 20,
                    divisions: 19,
                    label: '$pages',
                    onChanged: (value) => setDialogState(() => pages = value.round()),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'ℹ️ Sincroniza portada de JKAnime (banners, programación, top) y Latanime (calendario, emisión) junto con el catálogo.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Theme.of(context).colorScheme.outline),
                  ),
                ] else if (isHome) ...[
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    value: fetchContent,
                    onChanged: (value) => setDialogState(() => fetchContent = value),
                    title: const Text('Cargar el detalle de cada ítem (content)'),
                    subtitle: const Text('Scrapea reproductores y detalles de los títulos del home'),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'ℹ️ Sincroniza la portada de GNULA HD (banners destacados y todas las secciones de novedades y estrenos).',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Theme.of(context).colorScheme.outline),
                  ),
                ] else ...[
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    value: updateExisting,
                    onChanged: (value) => setDialogState(() {
                      updateExisting = value;
                      if (value) {
                        replace = false;
                        fetchContent = true;
                      }
                    }),
                    title: const Text('Solo actualizar el content'),
                    subtitle: const Text('Rescrapea el detalle de lo que ya existe'),
                  ),
                  Text(
                    updateExisting
                        ? 'Se actualizarán los ítems existentes en el backend.'
                        : 'Páginas a listar: $pages  (≈ ${pages * 32} ítems)',
                  ),
                  Slider(
                    value: pages.toDouble(),
                    min: 1,
                    max: SyncOptions.maxPages.toDouble(),
                    divisions: SyncOptions.maxPages - 1,
                    label: '$pages',
                    onChanged: updateExisting
                        ? null
                        : (value) => setDialogState(() => pages = value.round()),
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    value: replace,
                    onChanged: updateExisting
                        ? null
                        : (value) => setDialogState(() => replace = value),
                    title: const Text('Reemplazar el contenido'),
                    subtitle: const Text('La colección queda solo con lo que venga en el listado'),
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    value: fetchContent,
                    onChanged: updateExisting
                        ? null
                        : (value) => setDialogState(() => fetchContent = value),
                    title: const Text('Cargar el content de cada ítem'),
                    subtitle: const Text('Scrapea el detalle de cada título'),
                  ),
                ],
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
                (
                  options: SyncOptions(
                    pages: pages,
                    replace: replace,
                    fetchContent: updateExisting ? true : fetchContent,
                    updateExisting: updateExisting,
                  ),
                  intervalMinutes: minutes,
                ),
              ),
              child: const Text('Guardar'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _openSchedule(AutoSchedule schedule) async {
    final result = await _scheduleDialog(schedule);
    if (result == null || !mounted) return;
    final updated = AutoSchedule(
      job: schedule.job,
      enabled: schedule.enabled,
      intervalMinutes: result.intervalMinutes,
      options: result.options,
    );
    setState(() => widget.config.autoSchedules[schedule.job] = updated);
    await widget.config.setSchedule(updated);
    await registerAutoSync();
    _append('⏰ ${updated.label}: automático cada ${_fmtInterval(updated.intervalMinutes)}.');
  }

  Future<void> _toggleSchedule(AutoSchedule schedule, bool enabled) async {
    if (enabled && !_serviceActive) {
      await _ensureNotificationPermission();
    }
    final updated = AutoSchedule(
      job: schedule.job,
      enabled: enabled,
      intervalMinutes: schedule.intervalMinutes,
      options: schedule.options,
    );
    setState(() => widget.config.autoSchedules[schedule.job] = updated);
    await widget.config.setSchedule(updated);
    await registerAutoSync();
    _append(enabled ? '⏰ ${updated.label}: automático activado.' : '⏰ ${updated.label}: automático detenido.');
  }

  String _fmtInterval(int minutes) =>
      minutes >= 1440 ? '1 día' : (minutes < 60 ? '$minutes min' : '${minutes ~/ 60} h');

  String _nextIn(AutoSchedule schedule) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final due = (widget.config.lastRuns[schedule.job] ?? 0) + schedule.intervalMinutes * 60000;
    if (due > now) {
      final mins = ((due - now) / 60000).ceil();
      if (mins < 60) return 'en ~$mins min';
      final h = (mins / 60).ceil();
      return 'en ~$h h';
    }
    return 'pendiente';
  }

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

    final result = await FlutterForegroundTask.startService(
      serviceId: syncServiceId,
      serviceTypes: const [ForegroundServiceTypes.dataSync],
      notificationTitle: 'veamosTVSync activo',
      notificationText: 'En espera de una sincronización',
    );
    if (result is ServiceRequestFailure) {
      _append('❌ No se pudo iniciar el servicio: ${result.error}');
      setState(() => _keepAlive = false);
      return;
    }
    setState(() => _serviceActive = true);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final activeSchedulesCount =
        widget.config.autoSchedules.values.where((s) => s.enabled).length;

    return Scaffold(
      appBar: AppBar(
        title: const Text('veamosTVSync'),
        leading: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 0, 8),
          child: Image.asset('assets/icons/app_icon.png'),
        ),
        actions: [
          if (_running)
            IconButton(
              icon: const Icon(Icons.stop_circle_outlined, color: Colors.redAccent),
              tooltip: 'Detener',
              onPressed: _stop,
            ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (!widget.config.isConfigured)
                  InkWell(
                    onTap: widget.onOpenSettings,
                    borderRadius: BorderRadius.circular(8),
                    child: Container(
                      margin: const EdgeInsets.only(bottom: 12),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: theme.colorScheme.errorContainer,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Row(
                        children: [
                          Icon(Icons.warning_amber_rounded, color: theme.colorScheme.error),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              '⚠️ Configura la URL del backend y el token en Ajustes.',
                              style: theme.textTheme.bodyMedium?.copyWith(
                                color: theme.colorScheme.onErrorContainer,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                          const Icon(Icons.chevron_right, size: 20),
                        ],
                      ),
                    ),
                  ),

                // Botones principales de sincronización
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    FilledButton.icon(
                      onPressed: _running ? null : () => _run(const [SyncTask.all]),
                      icon: const Icon(Icons.sync, size: 18),
                      label: const Text('Sync completo'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _running ? null : () => _run(const [SyncTask.home]),
                      icon: const Icon(Icons.home, size: 18),
                      label: const Text('Home GNULA'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _running ? null : () => _runKind(SyncTask.movies, 'Películas'),
                      icon: const Icon(Icons.movie, size: 18),
                      label: const Text('Películas'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _running ? null : () => _runKind(SyncTask.series, 'Series'),
                      icon: const Icon(Icons.live_tv, size: 18),
                      label: const Text('Series'),
                    ),
                    // Botón único para Anime: sincroniza el Home Anime (JKAnime + Latanime) directamente
                    OutlinedButton.icon(
                      onPressed: _running ? null : () => _run(const [SyncTask.anime]),
                      icon: const Icon(Icons.animation, size: 18),
                      label: const Text('Anime'),
                    ),
                    if (_resumable)
                      FilledButton.tonalIcon(
                        onPressed: _running ? null : () => _run(const [], resume: true),
                        icon: const Icon(Icons.play_arrow, size: 18),
                        label: const Text('Continuar'),
                      ),
                  ],
                ),

                // Indicador de progreso activo
                if (_running) ...[
                  const SizedBox(height: 12),
                  LinearProgressIndicator(value: _total > 0 ? _done / _total : null),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          _currentStep.isNotEmpty ? _currentStep : 'Procesando...',
                          style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.bold),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (_total > 0)
                        Text('$_done/$_total  ·  $_saved guardados', style: theme.textTheme.bodySmall),
                    ],
                  ),
                ],

                const SizedBox(height: 4),

                // Sección desplegable para automatización y segundo plano
                Theme(
                  data: theme.copyWith(dividerColor: Colors.transparent),
                  child: ExpansionTile(
                    tilePadding: EdgeInsets.zero,
                    dense: true,
                    title: Text(
                      'Sincronización automática ($activeSchedulesCount activas)',
                      style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                    ),
                    subtitle: Text(
                      _keepAlive ? 'Servicio persistente activo' : 'Toca para programar intervalos automáticos',
                      style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
                    ),
                    children: [
                      SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        dense: true,
                        value: _keepAlive,
                        onChanged: _setKeepAlive,
                        title: const Text('Mantener activo en segundo plano'),
                        subtitle: const Text('Notificación fija para que Android no detenga la CPU'),
                      ),
                      for (final job in AppConfig.autoJobs) ...[
                        Builder(
                          builder: (context) {
                            final schedule = widget.config.autoSchedules[job]!;
                            final next = schedule.enabled ? '· próxima ${_nextIn(schedule)}' : '';
                            return SwitchListTile(
                              contentPadding: EdgeInsets.zero,
                              dense: true,
                              value: schedule.enabled,
                              onChanged: (value) => _toggleSchedule(schedule, value),
                              title: Text(schedule.label),
                              subtitle: Text('cada ${_fmtInterval(schedule.intervalMinutes)} $next'),
                              secondary: IconButton(
                                icon: const Icon(Icons.settings, size: 20),
                                onPressed: () => _openSchedule(schedule),
                              ),
                            );
                          },
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),

          const Divider(height: 1),

          // Encabezado de la barra de logs
          Container(
            color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.35),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: Row(
              children: [
                const Icon(Icons.terminal, size: 18),
                const SizedBox(width: 8),
                Text(
                  'LOG DE EJECUCIÓN',
                  style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.bold),
                ),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primaryContainer,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    '${_log.length}',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onPrimaryContainer,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                const Spacer(),
                if (_log.isNotEmpty) ...[
                  TextButton.icon(
                    style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                    onPressed: () => setState(() => _log.clear()),
                    icon: const Icon(Icons.clear_all, size: 16),
                    label: const Text('Limpiar'),
                  ),
                  const SizedBox(width: 4),
                  Builder(
                    builder: (btnContext) => TextButton.icon(
                      style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                      onPressed: () async {
                        final messenger = ScaffoldMessenger.of(btnContext);
                        await Clipboard.setData(ClipboardData(text: _log.join('\n')));
                        messenger.showSnackBar(
                          const SnackBar(content: Text('Log copiado al portapapeles')),
                        );
                      },
                      icon: const Icon(Icons.copy, size: 16),
                      label: const Text('Copiar'),
                    ),
                  ),
                ],
              ],
            ),
          ),

          // Área de registros (Log View)
          Expanded(child: _buildLogView(theme)),
        ],
      ),
    );
  }

  Widget _buildLogView(ThemeData theme) {
    if (_log.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.receipt_long_outlined, size: 48, color: theme.colorScheme.outline),
              const SizedBox(height: 12),
              Text(
                'Los registros de sincronización aparecerán aquí.',
                style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.outline),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 4),
              Text(
                'Presiona «Anime» o cualquier botón superior para iniciar.',
                style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline.withValues(alpha: 0.7)),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
    }

    return Container(
      color: Colors.black.withValues(alpha: 0.2),
      child: ListView.builder(
        controller: _scroll,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        itemCount: _log.length,
        itemBuilder: (context, index) {
          final line = _log[index];
          Color? textColor;
          if (line.contains('❌') || line.contains('Error') || line.contains('falló')) {
            textColor = Colors.redAccent.shade100;
          } else if (line.contains('✅') || line.contains('completad') || line.contains('guardado')) {
            textColor = Colors.greenAccent.shade200;
          } else if (line.contains('⚠️') || line.contains('aviso')) {
            textColor = Colors.amberAccent.shade100;
          } else if (line.contains('═══') || line.contains('▶')) {
            textColor = Colors.cyanAccent.shade100;
          }

          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: SelectableText(
              line,
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 12.5,
                color: textColor ?? theme.textTheme.bodySmall?.color,
                height: 1.35,
              ),
            ),
          );
        },
      ),
    );
  }
}
