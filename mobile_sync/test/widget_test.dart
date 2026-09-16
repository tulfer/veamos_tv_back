import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:veamos_sync/config.dart';
import 'package:veamos_sync/main.dart';

void main() {
  testWidgets('veamosTVSync smoke test', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});
    final config = await AppConfig.load();

    await tester.pumpWidget(VeamosSyncApp(config: config));
    await tester.pumpAndSettle();

    expect(find.text('veamosTVSync'), findsOneWidget);
    expect(find.text('Sync completo'), findsOneWidget);
    expect(find.text('Ajustes'), findsOneWidget);
  });
}