import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:workmanager/workmanager.dart';

import 'config.dart';
import 'screens/settings_screen.dart';
import 'screens/sync_screen.dart';
import 'services/auto_schedule.dart';
import 'services/notifications.dart';
import 'services/push.dart';

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

  // Firebase (FCM): la app recibe órdenes push ("content"/"search") del
  // backend cuando GNULA no responde desde el servidor y hay que scrapear
  // desde la IP residencial del celular.
  try {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
    FirebaseMessaging.onMessage.listen((message) {
      // App abierta: se ejecuta la tarea igual (el listener no bloquea la UI).
      unawaited(executePushTask(message.data));
    });
  } catch (error) {
    // Sin google-services.json / config de Firebase la app sigue funcionando
    // (solo pierde el push); el mate del error se informa en el log. 
    // ignore: avoid_print
    print('[fcm] no se pudo inicializar Firebase: $error');
  }

  // Sincronización automática (WorkManager): corre en segundo plano aunque la
  // app esté cerrada, con la frecuencia (mín. 15 min) de lo habilitado.
  try {
    Workmanager().initialize(autoSyncCallbackDispatcher);
  } catch (error) {
    // ignore: avoid_print
    print('[auto-sync] no se pudo inicializar WorkManager: $error');
  }

  final config = await AppConfig.load();

  // Notificaciones locales (avances/resultados de background y push).
  try {
    await initNotifications();
    await registerAutoSync();
    await registerFcmToken(config);
  } catch (error) {
    // ignore: avoid_print
    print('[setup] $error');
  }

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
          SyncScreen(
            config: widget.config,
            onOpenSettings: () => setState(() => _tab = 1),
          ),
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