import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// Notificaciones locales de la app. Se usan tanto desde el isolate de la UI
/// como desde los isolates en segundo plano (WorkManager / FCM), por eso la
/// inicialización corre dentro de cada tarea (cada isolate tiene su propio
/// registro de plugins).
final FlutterLocalNotificationsPlugin localNotifications = FlutterLocalNotificationsPlugin();

const String _channelId = 'veamos_sync_tasks';
const String _channelName = 'Tareas de sincronización';
const String _channelDescription = 'Avances de la sincronización automática y de las órdenes push recibidas del backend.';

Future<void> initNotifications() async {
  const android = AndroidInitializationSettings('@mipmap/ic_launcher');
  const ios = DarwinInitializationSettings(
    requestAlertPermission: false,
    requestBadgePermission: false,
    requestSoundPermission: false,
  );
  await localNotifications.initialize(
    const InitializationSettings(android: android, iOS: ios),
  );

  // Android 13+: permiso de notificaciones en runtime.
  final impl =
      localNotifications.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
  await impl?.requestNotificationsPermission();
}

Future<void> showNotification({required int id, required String title, required String body}) async {
  try {
    await localNotifications.show(
      id,
      title,
      body,
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          _channelName,
          channelDescription: _channelDescription,
          importance: Importance.high,
          priority: Priority.high,
        ),
        iOS: DarwinNotificationDetails(),
      ),
    );
  } catch (_) {
    // Fallo silencioso: la notificación es informativa.
  }
}