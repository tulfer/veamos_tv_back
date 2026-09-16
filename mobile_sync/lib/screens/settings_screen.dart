import 'package:flutter/material.dart';

import '../config.dart';

class SettingsScreen extends StatefulWidget {
  final AppConfig config;

  const SettingsScreen({super.key, required this.config});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController _backend;
  late final TextEditingController _token;
  late final TextEditingController _domains;
  String _message = '';

  @override
  void initState() {
    super.initState();
    _backend = TextEditingController(text: widget.config.backendUrl);
    _token = TextEditingController(text: widget.config.syncToken);
    _domains = TextEditingController(text: widget.config.gnulaDomains.join('\n'));
  }

  @override
  void dispose() {
    _backend.dispose();
    _token.dispose();
    _domains.dispose();
    super.dispose();
  }

  Future<void> _save(ScaffoldMessengerState messenger) async {
    widget.config.backendUrl = _backend.text.trim().replaceAll(RegExp(r'/+$'), '');
    widget.config.syncToken = _token.text.trim();
    widget.config.gnulaDomains = _domains.text
        .split('\n')
        .map((d) => d.trim())
        .where((d) => d.isNotEmpty)
        .toList();
    if (widget.config.gnulaDomains.isEmpty) {
      widget.config.gnulaDomains = const ['https://ww3.gnulahd.nu', 'https://gnulahd.nu', 'https://gnulahd.click'];
    }
    await widget.config.save();
    setState(() => _message = 'Guardado. El backend es ${_backend.text.trim().isEmpty ? '—' : _backend.text.trim()}.');
    messenger.showSnackBar(const SnackBar(content: Text('Configuración guardada')));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Ajustes'),
        leading: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 0, 8),
          child: Image.asset('assets/icons/app_icon.png'),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'URL del backend (dónde se sirve el panel de sincronización), sin /sync/ingest.',
            style: TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _backend,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(
              labelText: 'URL del backend',
              hintText: 'https://veamos.example.com',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'Token de ingesta (SYNC_INGEST_TOKEN configurado en el servidor).',
            style: TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _token,
            obscureText: true,
            decoration: const InputDecoration(
              labelText: 'Token de ingesta',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'Dominios de GNULA (uno por línea). El primero en responder se usa.',
            style: TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _domains,
            maxLines: 4,
            decoration: const InputDecoration(
              labelText: 'Dominios de GNULA',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 20),
          Builder(
            builder: (context) => FilledButton.icon(
              onPressed: () => _save(context.findAncestorStateOfType<ScaffoldMessengerState>()!),
              icon: const Icon(Icons.save),
              label: const Text('Guardar'),
            ),
          ),
          if (_message.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(_message, style: Theme.of(context).textTheme.bodySmall),
          ],
        ],
      ),
    );
  }
}