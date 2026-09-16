#!/usr/bin/env node
// Aplica el branding a los archivos generados por `flutter create`:
//   - ID de bundle/android:  com.veamos.tv.sync
//   - Nombre visible:        veamosTVSync  (label de Android + DisplayName de iOS)
// Ejecutar SIEMPRE después de `flutter create`, es idempotente.
// Uso: node tools/apply_branding.mjs   (desde mobile_sync/)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_ID = 'com.veamos.tv.sync';
const APP_NAME = 'veamosTVSync';

let changed = false;

function patch(file, run) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.log(`  - omitido (no existe): ${file}`);
    return;
  }
  const text = fs.readFileSync(abs, 'utf8');
  const next = run(text);
  if (next === text) {
    console.log(`  - sin cambios: ${file}`);
    return;
  }
  fs.writeFileSync(abs, next);
  changed = true;
  console.log(`  - OK: ${file}`);
}

console.log('Aplicando branding veamosTVSync / com.veamos.tv.sync...');

// Android
console.log('Android:');
patch('android/app/build.gradle.kts', (t) =>
  t
    .replace(/(namespace\s*=\s*")[^"]*"/g, `$1${BUNDLE_ID}"`)
    .replace(/(applicationId\s*=\s*")[^"]*"/g, `$1${BUNDLE_ID}"`),
);
patch('android/app/build.gradle', (t) =>
  t
    .replace(/(namespace\s+)".*?"/g, `$1"${BUNDLE_ID}"`)
    .replace(/(applicationId\s+)".*?"/g, `$1"${BUNDLE_ID}"`),
);
patch('android/app/src/main/AndroidManifest.xml', (t) => t.replace(/android:label="[^"]*"/g, `android:label="${APP_NAME}"`));

// iOS
console.log('iOS:');
patch('ios/Runner.xcodeproj/project.pbxproj', (t) =>
  t.replace(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*[^;]*;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};`),
);
patch('ios/Runner/Info.plist', (t) =>
  t.replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${APP_NAME}$2`),
);

console.log(
  changed
    ? 'Listo. Ahora ejecuta `dart run flutter_launcher_icons` para generar los iconos.'
    : 'Nada que cambiar (¿ya estaba aplicado?).',
);