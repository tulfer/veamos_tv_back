import 'dart:async';

import '../models.dart';
import 'gnula_client.dart';
import 'ingest_api.dart';

/// Tarea de sincronización solicitada desde la UI.
enum SyncTask { all, home, movies, series, anime }

const Map<String, String> syncKindLabels = {
  'peliculas': 'PELÍCULAS',
  'series': 'SERIES',
  'anime': 'ANIME',
};

/// Colección de ingesta (plural) a partir del tipo de un ítem (`movie`).
const Map<String, String> syncTypeToCollection = {
  'movie': 'movies',
  'movies': 'movies',
  'series': 'series',
  'anime': 'anime',
};

const Map<String, String> syncTypeLabels = {
  'movies': 'PELÍCULAS',
  'series': 'SERIES',
  'anime': 'ANIME',
};

/// Opciones elegidas por el usuario al lanzar una sincronización de catálogo.
class SyncOptions {
  /// Cuántas páginas del listado scrapear (1 = sólo la primera).
  final int pages;

  /// Reemplaza la colección completa en el backend (borra lo que ya no exista).
  final bool replace;

  /// Scrapea el detalle (`content`) de cada ítem y lo sube enriquecido.
  final bool fetchContent;

  const SyncOptions({this.pages = 1, this.replace = false, this.fetchContent = true});

  /// Tope de páginas (el backend acepta hasta 500 ítems por lote).
  static const int maxPages = 15;

  Map<String, dynamic> toJson() => {
        'pages': pages,
        'replace': replace,
        'fetchContent': fetchContent,
      };

  factory SyncOptions.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const SyncOptions();
    final raw = (json['pages'] as num?)?.toInt() ?? 1;
    return SyncOptions(
      pages: raw < 1 ? 1 : (raw > maxPages ? maxPages : raw),
      replace: json['replace'] == true,
      fetchContent: json['fetchContent'] != false,
    );
  }
}

List<SyncTask> syncTasksFromNames(List<String> names) {
  final tasks = <SyncTask>[];
  for (final name in names) {
    for (final task in SyncTask.values) {
      if (task.name == name && !tasks.contains(task)) tasks.add(task);
    }
  }
  return tasks.isEmpty ? const [SyncTask.all] : tasks;
}

typedef SyncLogFn = void Function(String message);

/// `done`/`total` describen el progreso del detalle de ítems (0/0 si no aplica).
typedef SyncProgressFn = void Function(int done, int total, int saved, String step);

/// Persistencia del punto de control de una sincronización, para poder
/// reanudarla (p. ej. tras un timeout de red). La implementación real usa
/// `flutter_foreground_task` (ver `sync_task_handler.dart`).
abstract class SyncCheckpointStore {
  Future<Map<String, dynamic>?> load();
  Future<void> save(Map<String, dynamic> checkpoint);
  Future<void> clear();
}

/// Store en memoria (tests / sin persistencia).
class MemorySyncCheckpointStore implements SyncCheckpointStore {
  Map<String, dynamic>? _data;

  @override
  Future<Map<String, dynamic>?> load() async => _data;

  @override
  Future<void> save(Map<String, dynamic> checkpoint) async => _data = checkpoint;

  @override
  Future<void> clear() async => _data = null;
}

/// Unidad de trabajo reanudable: scrapear el detalle de una lista de ítems.
class _DetailJob {
  final String id;
  final String type; // movies | series | anime (colección de ingesta)
  final String label;
  final String? kind; // para scrapear el listado (peliculas/series/anime)
  final List<MediaItem>? items; // para los ítems del home (ya resueltos)
  final int pages;
  final bool replace;
  final bool fetchContent;

  _DetailJob({
    required this.id,
    required this.type,
    required this.label,
    this.kind,
    this.items,
    this.pages = 1,
    this.replace = false,
    this.fetchContent = true,
  });
}

/// Núcleo de la sincronización: scrapea GNULA y sube al backend. Se ejecuta
/// dentro del isolate del [TaskHandler] del foreground service (ver
/// `sync_task_handler.dart`), por eso no toca la UI ni plataformas salvo
/// `dart:io` (todo el cliente GNULA/ingesta es Dart puro).
class SyncRunner {
  SyncRunner({
    required this.backendUrl,
    required this.token,
    required this.domains,
    required SyncLogFn log,
    required SyncProgressFn onProgress,
    SyncCheckpointStore? store,
    bool Function()? shouldStop,
  })  : _log = log,
        _onProgress = onProgress,
        _store = store ?? MemorySyncCheckpointStore(),
        _shouldStop = shouldStop ?? (() => false) {
    _client = GnulaClient(staticDomains: domains, log: log);
    _api = IngestApi(baseUrl: backendUrl, token: token, log: log);
  }

  /// Cuántas veces se reanuda sola tras un timeout antes de rendirse.
  static const int maxAutoResumes = 3;
  static const Duration autoResumeDelay = Duration(seconds: 5);

  final String backendUrl;
  final String token;
  final List<String> domains;
  final SyncLogFn _log;
  final SyncProgressFn _onProgress;
  final SyncCheckpointStore _store;
  final bool Function() _shouldStop;

  late final GnulaClient _client;
  late final IngestApi _api;

  int _done = 0;
  int _total = 0;
  int _saved = 0;

  // Estado del punto de control (se persiste tras cada lote enviado).
  List<String> _taskNames = const [];
  bool _homeDone = false;
  final Set<String> _doneJobs = {};
  Map<String, dynamic>? _currentJob;
  SyncOptions _options = const SyncOptions();

  bool get _cancelled => _shouldStop();

  void _progress(String step) => _onProgress(_done, _total, _saved, step);

  Future<void> _saveCheckpoint() => _store.save({
        'tasks': _taskNames,
        'homeDone': _homeDone,
        'doneJobs': _doneJobs.toList(),
        'current': _currentJob,
        'options': _options.toJson(),
      });

  /// Corre la sincronización. Si falla por timeout, se reanuda automáticamente
  /// desde el punto de control hasta [maxAutoResumes] veces; si aun así falla,
  /// queda disponible el botón "Continuar" de la UI (`resume: true`).
  Future<void> run(List<SyncTask> tasks, {bool resume = false, SyncOptions? options}) async {
    _options = options ?? const SyncOptions();
    if (!resume) await _store.clear();
    var attempts = 0;
    while (true) {
      try {
        await _runOnce(tasks);
        await _store.clear();
        return;
      } on TimeoutException {
        if (_cancelled) rethrow;
        if (attempts >= maxAutoResumes) {
          _log('❌ Timeout repetido ($maxAutoResumes veces). Usa «Continuar» para reintentar.');
          rethrow;
        }
        attempts++;
        _log('⏱️ Timeout: reanudando automáticamente ($attempts/$maxAutoResumes) en ${autoResumeDelay.inSeconds}s...');
        await Future<void>.delayed(autoResumeDelay);
      }
    }
  }

  Future<void> _runOnce(List<SyncTask> requestedTasks) async {
    final cp = await _store.load();
    if (cp != null) {
      // Al reanudar (automático o con «Continuar») se recuperan las opciones
      // elegidas originalmente (páginas, reemplazo, content).
      _options = SyncOptions.fromJson((cp['options'] as Map?)?.cast<String, dynamic>());
    }
    _taskNames = (cp?['tasks'] as List?)?.cast<String>() ?? requestedTasks.map((t) => t.name).toList();
    _homeDone = cp?['homeDone'] == true;
    _doneJobs
      ..clear()
      ..addAll(((cp?['doneJobs'] as List?) ?? const []).cast<String>());
    _currentJob = (cp?['current'] as Map?)?.cast<String, dynamic>();

    final tasks = syncTasksFromNames(_taskNames);
    final all = tasks.contains(SyncTask.all);
    final wantsHome = all || tasks.contains(SyncTask.home);

    // ── Etapa HOME (scrape + subida del home) ──
    GnulahdHomeData? home;
    if (wantsHome && !_homeDone) {
      _log('═══ Sincronizando HOME ═══');
      _progress('Scrapeando home de GNULA...');
      home = await _client.scrapeHome();
      _log('Home scrapeado: ${home.banners.length} banners, ${home.sections.length} secciones');
      await _api.sendHome(home);
      _homeDone = true;
      await _saveCheckpoint();
    }

    // ── Cola de trabajos de detalle ──
    final jobs = <_DetailJob>[];
    if (all) {
      for (final kind in ['peliculas', 'series', 'anime']) {
        jobs.add(_DetailJob(
          id: kind,
          kind: kind,
          type: _kindToType(kind),
          label: syncKindLabels[kind]!,
          pages: _options.pages,
          replace: _options.replace,
          fetchContent: _options.fetchContent,
        ));
      }
    } else if (wantsHome) {
      home ??= await _client.scrapeHome();
      jobs.addAll(_homeDetailJobs(home));
    } else {
      for (final task in tasks) {
        final kind = _taskToKind(task);
        if (kind != null) {
          jobs.add(_DetailJob(
            id: kind,
            kind: kind,
            type: _kindToType(kind),
            label: syncKindLabels[kind]!,
            pages: _options.pages,
            replace: _options.replace,
            fetchContent: _options.fetchContent,
          ));
        }
      }
    }

    for (final job in jobs) {
      if (_cancelled) return;
      if (_doneJobs.contains(job.id)) continue;

      final resuming = _currentJob != null && _currentJob!['jobId'] == job.id;
      var catalogDone = resuming && _currentJob!['catalogDone'] == true;
      var start = resuming ? (_currentJob!['doneCount'] as num?)?.toInt() ?? 0 : 0;

      List<MediaItem> items;
      if (job.items != null) {
        items = job.items!;
      } else {
        _log('═══ Sincronizando ${job.label} ═══');
        items = await _scrapePages(job.kind!, job.pages);
        if (items.isEmpty) {
          _log('⚠️ El listado de ${job.kind} quedó vacío (anti-bot?). Se omite.');
          _doneJobs.add(job.id);
          await _saveCheckpoint();
          continue;
        }
        _log('Listado: ${items.length} títulos (${job.pages} página(s))');
      }

      // Catálogo sin detalle: reemplaza o sube los ítems tal cual (rápido).
      // Aplica a los listados, no a los ítems del home (siempre con content).
      if (job.items == null && (job.replace || !job.fetchContent) && !catalogDone) {
        await _sendCatalog(job, items);
        catalogDone = true;
        _currentJob = {'jobId': job.id, 'doneCount': 0, 'catalogDone': true};
        await _saveCheckpoint();
      }

      if (job.fetchContent) {
        if (start > 0) _log('↩️ Reanudando ${job.label} en el ítem ${start + 1}/${items.length}.');
        await _scrapeAndSend(job, items, start: start, catalogDone: catalogDone);
      } else {
        _log('${job.label}: catálogo guardado sin content (${items.length} ítems).');
      }

      _doneJobs.add(job.id);
      _currentJob = null;
      await _saveCheckpoint();
    }
  }

  /// Scrapea [pages] páginas del listado [kind] y devuelve los ítems únicos.
  Future<List<MediaItem>> _scrapePages(String kind, int pages) async {
    final seen = <String>{};
    final items = <MediaItem>[];
    for (var page = 1; page <= pages; page++) {
      if (_cancelled) break;
      _progress('Listando $kind (página $page/$pages)...');
      List<MediaItem> pageItems;
      try {
        pageItems = await _client.scrapeList(kind, page: page);
      } catch (error) {
        _log('⚠️ $kind página $page: $error');
        break;
      }
      if (pageItems.isEmpty) {
        if (page > 1) _log('$kind: página $page vacía; fin del listado.');
        break;
      }
      var added = 0;
      for (final item in pageItems) {
        if (seen.add(item.id)) {
          items.add(item);
          added++;
        }
      }
      _log('$kind pág. $page: $added nuevos');
    }
    return items;
  }

  /// Sube el catálogo sin `content`. Con `replace`, la primera escritura
  /// reemplaza toda la colección (elimina lo que ya no está en GNULA).
  Future<void> _sendCatalog(_DetailJob job, List<MediaItem> items) async {
    final payload = items.map((item) => item.toCatalogJson()).toList();
    _total = payload.length;
    _done = payload.length;
    _saved = 0;
    const chunkSize = 200; // < MAX_INGEST_ITEMS (500) del backend
    var sent = 0;
    for (var i = 0; i < payload.length; i += chunkSize) {
      if (_cancelled) break;
      final end = (i + chunkSize) < payload.length ? (i + chunkSize) : payload.length;
      final part = payload.sublist(i, end);
      _progress('Guardando catálogo ${job.label} ($sent/${payload.length})...');
      await _api.sendItems(job.type, part, enrich: false, replace: job.replace && i == 0);
      sent += part.length;
      _saved = sent;
      _progress('Guardando catálogo ${job.label} ($sent/${payload.length})...');
    }
    _log('${job.label}: catálogo ${job.replace ? 'reemplazado' : 'actualizado'} ($sent/${payload.length} ítems).');
  }

  String? _taskToKind(SyncTask task) {
    switch (task) {
      case SyncTask.movies:
        return 'peliculas';
      case SyncTask.series:
        return 'series';
      case SyncTask.anime:
        return 'anime';
      default:
        return null;
    }
  }

  String _kindToType(String kind) => kind == 'peliculas' ? 'movies' : kind;

  List<_DetailJob> _homeDetailJobs(GnulahdHomeData home) {
    final seen = <String>{};
    final items = <MediaItem>[];
    for (final b in home.banners) {
      if (seen.add(b.id)) items.add(b);
    }
    for (final section in home.sections) {
      for (final item in section.items) {
        if (seen.add(item.id)) items.add(item);
      }
    }
    _log('Home: ${items.length} ítems únicos (banners + secciones)');
    // Los ítems del home traen el tipo en singular (`movie`); se normaliza a la
    // colección de ingesta (`movies`/`series`/`anime`).
    final byType = <String, List<MediaItem>>{};
    for (final item in items) {
      final collection = syncTypeToCollection[item.type] ?? item.type;
      byType.putIfAbsent(collection, () => []).add(item);
    }
    final jobs = <_DetailJob>[];
    for (final type in ['movies', 'series', 'anime']) {
      final typed = byType[type];
      if (typed == null || typed.isEmpty) continue;
      jobs.add(_DetailJob(
        id: 'home:$type',
        type: type,
        label: syncTypeLabels[type] ?? type,
        items: typed,
      ));
    }
    return jobs;
  }

  /// Scrapea el detalle de cada ítem desde [start] y los sube en lotes de 5 con
  /// `enrich`. Persiste el avance después de cada lote confirmado.
  Future<void> _scrapeAndSend(_DetailJob job, List<MediaItem> items, {int start = 0, bool catalogDone = false}) async {
    _total = items.length;
    _done = start;
    _saved = start;
    _progress('Scrapeando ${job.label}...');

    const batchSize = 5;
    final batch = <Map<String, dynamic>>[];
    var sent = start;
    for (var i = start; i < items.length; i++) {
      if (_cancelled) break;
      final item = items[i];
      _progress('Scrapeando detalle ${i + 1}/${items.length}: "${item.title}"');
      try {
        final detail = await _client.scrapeDetail(item);
        batch.add({
          ...item.toCatalogJson(),
          'content': detail.toJson(),
          'contentUpdatedAt': DateTime.now().millisecondsSinceEpoch,
        });
      } catch (error) {
        _log('⚠️ ${item.title}: $error');
      }
      _done = i + 1;
      _progress('Scrapeando detalle ${i + 1}/${items.length}: "${item.title}"');

      if (batch.length >= batchSize || i == items.length - 1) {
        if (batch.isNotEmpty) {
          // Si esto lanza (timeout), NO se avanza el checkpoint: el lote se
          // reintenta al reanudar.
          final saved = await _api.sendItems(job.type, List.of(batch), enrich: true);
          sent += saved;
          _saved = sent;
          batch.clear();
          _currentJob = {'jobId': job.id, 'doneCount': i + 1, 'catalogDone': catalogDone};
          await _saveCheckpoint();
          _progress('Guardando ${job.label} ($sent/${items.length})...');
        }
      }
    }
    _log('${job.label} (${job.type}): $sent/${items.length} guardadas en el backend.');
  }

  Future<void> close() async {
    await _client.close();
    _api.close();
  }
}
