# Veamos Sync (veamosTVSync)

App en **Flutter** para sincronizar GNULA HD hacia el backend de Veamos TV.

- **Nombre visible:** veamosTVSync
- **ID (Android + iOS):** `com.veamos.tv.sync`

## Por qué

DDoS-Guard bloquea las IPs de datacenter (dokploy/Cloud Run) del backend. La
solución probada es hacer el scraping desde una IP **residencial**. Esta app se
ejecuta en tu celular: scrapea GNULA desde tu conexión doméstica, sube los
datos al backend (`POST /sync/ingest`) y el backend persiste y **enriquece** el
detalle con los demás proveedores (PelisPlus, PelisPedia, JKAnime, Latanime),
que sí aceptan la IP del servidor.

Mientras sincroniza la pantalla queda **encendida** (`wakelock_plus`), porque
los modos de suspensión de Android matan el proceso en segundo plano.

## Requisitos

- Flutter SDK (https://docs.flutter.dev/get-started/install)
- Un celular Android/iOS con la app instalada
- La URL del backend (donde vive el panel de sincronización) y el token de
  ingesta (`SYNC_INGEST_TOKEN`) configurado en el servidor.

## Crear el proyecto (una vez)

El código ya está listo; solo falta generar el scaffolding de las plataformas:

```sh
cd mobile_sync
flutter create --platforms android,ios .
```

Luego aplicar el branding (nombre visible + id `com.veamos.tv.sync`). Este paso
es **obligatorio** y se corre en Windows con Node:

```sh
node tools/apply_branding.mjs
```

Y generar los iconos de la app (logo de `assets/icons/app_icon.png`, diseñado
con los colores de la marca #667eea → #764ba2):

```sh
dart run flutter_launcher_icons
```

> Para regenerar el logo (si tocás `tools/generate_icon.ps1`):
> `powershell -ExecutionPolicy Bypass -File tools/generate_icon.ps1`

## Correr

```sh
cd mobile_sync
flutter run
```

En **Ajustes** dentro de la app:

- **URL del backend**: la base del servidor, p.ej. `https://veamos.example.com`
  (sin `/sync/ingest`).
- **Token de ingesta**: el valor de `SYNC_INGEST_TOKEN`.
- **Dominios de GNULA** (opcional): uno por línea; el primero que responda se usa.

Luego volvé a **Sync** y elegí:

- **Sync completo**: home + películas (pág. 1) + series (pág. 1).
- **Solo home / Películas / Series**: subconjuntos.

## Cómo funciona el flujo

1. La app scrapea el home de GNULA (banners + secciones) y lo sube.
2. Scrapea el listado `/ver/peliculas` (y `/ver/series`), y por cada título su
   detalle (poster, descripción, player, episodios — hasta 60 episodios por
   serie; el resto se resuelve bajo demanda al abrir el título).
3. Cada lote de detalle se sube a `POST /sync/ingest` con `enrich=true`: el
   backend guarda en las colecciones v2 (`gnulahd-movies` / `gnulahd-series`)
   y mezcla servidores de PelisPlus/PelisPedia (o JKAnime/Latanime en anime).

## Limitaciones conocidas

- El sync de **anime** no se hace desde la app: el backend lo resuelve con
  jkanime/latanime (sin bloqueo).
- La sincronización debe correr con la app en **primer plano** (pantalla
  encendida). No hay soporte de background (limitación de los móviles).
- Solo se sincroniza la **página 1** de cada listado por ahora; se puede
  ampliar `scrapeList(page:)` si se quiere el catálogo completo.

## Referencia del scraper

Portado de `src/providers/gnulahd.ts` (Node/cheerio → Dart/package:html).
Mantiene: cookie jar + interstitial DDoS-Guard (`/?gnm=1`), rotación de
dominios, y la desofuscación del player (base64 + XOR clave `[103,78,55,100]`
= `'gN7d'`).