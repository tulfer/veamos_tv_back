import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../config.dart';
import '../services/gnula_client.dart';
import '../services/ingest_api.dart';

enum SyncTask { all, home, movies, series }

/// Pantalla principal de sincronización. Mantiene la pantalla encendida
/// mientras una tarea corre (los modos de suspensión de Android matan el
/// scraping en background; con wakelock no se apaga durante la ejecución).
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
  int _done = 0;
  int _total = 0;
  int _saved = 0;
  String _currentStep = '';
  GnulaClient? _client;
  IngestApi? _api;

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

  Future<void> _run(List<SyncTask> tasks) async {
    if (_running) return;
    if (!widget.config.isConfigured) {
      _append('❌ Configura la URL del backend y el token en Ajustes.');
      return;
    }
    setState(() {
      _running = true;
      _done = 0;
      _total = 0;
      _saved = 0;
      _log.clear();
      _currentStep = 'Iniciando...';
    });

    try {
      await WakelockPlus.enable();
      _client = GnulaClient(staticDomains: widget.config.gnulaDomains, log: _append);
      _api = IngestApi(baseUrl: widget.config.backendUrl, token: widget.config.syncToken, log: _append);

      bool want(Set<SyncTask> t) =>
          t.contains(SyncTask.all) || t.contains(SyncTask.home);
      final all = tasks.contains(SyncTask.all);

      if (want(tasks.toSet())) {
        _append('═══ Sincronizando HOME ═══');
        _currentStep = 'Scrapeando home de GNULA...';
        final home = await _client!.scrapeHome();
        _append('Home scrapeado: ${home.banners.length} banners, ${home.sections.length} secciones');
        await _api!.sendHome(home);
      }
      if (all || tasks.contains(SyncTask.movies)) {
        await _syncKind('peliculas', 'movies');
      }
      if (all || tasks.contains(SyncTask.series)) {
        await _syncKind('series', 'series');
      }
      _append('✅ Sincronización terminada.');
    } catch (error, stack) {
      _append('❌ Error: $error');
      if (kDebugMode) _append(stack.toString());
    } finally {
      await WakelockPlus.disable();
      setState(() {
        _running = false;
        _currentStep = '';
      });
    }
  }

  Future<void> _syncKind(String kind, String type) async {
    final label = kind == 'peliculas' ? 'PELÍCULAS' : 'SERIES';
    _append('═══ Sincronizando $label ═══');
    _currentStep = 'Listando $kind (página 1)...';
    final items = await _client!.scrapeList(kind, page: 1);
    if (items.isEmpty) {
      _append('⚠️ El listado de $kind quedó vacío (anti-bot?). Abortando.');
      return;
    }
    _append('Listado: ${items.length} títulos');
    setState(() {
      _total = items.length;
      _done = 0;
    });

    const batchSize = 5;
    final batch = <Map<String, dynamic>>[];
    var sent = 0;
    for (var i = 0; i < items.length; i++) {
      final item = items[i];
      _currentStep = 'Scrapeando detalle ${i + 1}/${items.length}: "${item.title}"';
      try {
        final detail = await _client!.scrapeDetail(item);
        batch.add({
          ...item.toCatalogJson(),
          'content': detail.toJson(),
          'contentUpdatedAt': DateTime.now().millisecondsSinceEpoch,
        });
      } catch (error) {
        _append('⚠️ ${item.title}: $error');
      }
      setState(() {
        _done = i + 1;
      });

      if (batch.length >= batchSize || i == items.length - 1) {
        if (batch.isNotEmpty) {
          final saved = await _api!.sendItems(type, List.of(batch), enrich: true);
          sent += saved;
          setState(() => _saved = sent);
          batch.clear();
        }
      }
    }
    _append('$label: $sent/${items.length} guardadas en el backend.');
  }

  @override
  void dispose() {
    _client?.close();
    _api?.close();
    _scroll.dispose();
    super.dispose();
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
                      onPressed: _running ? null : () => _run(const [SyncTask.movies]),
                      icon: const Icon(Icons.movie),
                      label: const Text('Películas'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _running ? null : () => _run(const [SyncTask.series]),
                      icon: const Icon(Icons.live_tv),
                      label: const Text('Series'),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                if (_running) ...[
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
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.all(12),
      itemCount: _log.length,
      itemBuilder: (context, index) => Text(_log[index], style: theme.textTheme.bodySmall),
    );
  }
}