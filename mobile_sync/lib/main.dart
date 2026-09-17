import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'config.dart';
import 'screens/settings_screen.dart';
import 'screens/sync_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Foreground service: permite que la sincronización siga corriendo cuando la
  // app pasa a segundo plano o se apaga la pantalla, mostrando una notificación
  // con el avance. `allowWakeLock` mantiene la CPU activa durante la sync.
  FlutterForegroundTask.initCommunicationPort();
  FlutterForegroundTask.init(
    androidNotificationOptions: AndroidNotificationOptions(
      channelId: 'veamos_sync_service',
      channelName: 'Sincronización veamosTVSync',
      channelDescription: 'Mantiene la sincronización de GNULA corriendo en segundo plano.',
      channelImportance: NotificationChannelImportance.LOW,
      priority: NotificationPriority.LOW,
      onlyAlertOnce: true,
    ),
    iosNotificationOptions: const IOSNotificationOptions(),
    foregroundTaskOptions: ForegroundTaskOptions(
      eventAction: ForegroundTaskEventAction.nothing(),
      allowWakeLock: true,
      allowWifiLock: true,
      stopWithTask: false,
    ),
  );

  final config = await AppConfig.load();
  runApp(VeamosSyncApp(config: config));
}

class VeamosSyncApp extends StatelessWidget {
  final AppConfig config;

  const VeamosSyncApp({super.key, required this.config});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'veamosTVSync',
      theme: ThemeData.dark(useMaterial3: true),
      home: Home(config: config),
    );
  }
}

class Home extends StatefulWidget {
  final AppConfig config;

  const Home({super.key, required this.config});

  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: [
          SyncScreen(config: widget.config),
          SettingsScreen(config: widget.config),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (index) => setState(() => _tab = index),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.sync), label: 'Sync'),
          NavigationDestination(icon: Icon(Icons.settings), label: 'Ajustes'),
        ],
      ),
    );
  }
}