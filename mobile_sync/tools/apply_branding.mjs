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

// Busca MainActivity en su carpeta original (kotlin o java) y la mueve al
// directorio del paquete destino, actualizando su declaración `package`.
function relocateMainActivity(lang) {
  const srcRoot = path.join(ROOT, 'android', 'app', 'src', 'main', lang);
  if (!fs.existsSync(srcRoot)) return false;
  let srcFile = null;
  for (const entry of fs.readdirSync(srcRoot, { recursive: true })) {
    const p = entry.toString().replaceAll('\\', '/');
    if (p.endsWith('/MainActivity.kt') || p.endsWith('/MainActivity.java')) {
      srcFile = path.join(srcRoot, entry);
      break;
    }
  }
  if (!srcFile) return false;
  const rel = path.relative(srcRoot, srcFile).replaceAll('\\', '/');
  if (rel === `com/veamos/tv/sync/MainActivity.${lang === 'java' ? 'java' : 'kt'}`) return true;

  const text = fs.readFileSync(srcFile, 'utf8');
  if (lang !== 'java') {
    fs.writeFileSync(srcFile, text.replace(/^package\s+\S+\s*$/m, `package ${BUNDLE_ID}`));
  } else {
    fs.writeFileSync(srcFile, text.replace(/^package\s+\S+\s*$/m, `package ${BUNDLE_ID};`));
  }
  const destDir = path.join(srcRoot, 'com', 'veamos', 'tv', 'sync');
  fs.mkdirSync(destDir, { recursive: true });
  const ext = lang === 'java' ? 'java' : 'kt';
  const destFile = path.join(destDir, `MainActivity.${ext}`);
  fs.renameSync(srcFile, destFile);
  removeEmptyParents(srcFile, srcRoot);
  changed = true;
  console.log(`  - OK: MainActivity.${ext} ≈> ${BUNDLE_ID}.MainActivity`);
  return true;
}

// Elimina carpetas intermedias vacías hacia arriba del archivo movido.
function removeEmptyParents(file, stopRoot) {
  let dir = path.dirname(file);
  while (dir.startsWith(stopRoot) && dir !== stopRoot) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
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

// Android: MainActivity.kt — el namespace/applicationId cambió, pero la clase
// sigue en el paquete original de `flutter create`; la reubicamos para que el
// runtime encuentre com.veamos.tv.sync.MainActivity.
console.log('Android MainActivity:');
const ktReloc = relocateMainActivity('kotlin') || relocateMainActivity('java');
if (!ktReloc) console.log('  - sin cambios (MainActivity no encontrada)');

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