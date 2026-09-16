import 'package:flutter/material.dart';

import 'config.dart';
import 'screens/settings_screen.dart';
import 'screens/sync_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
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