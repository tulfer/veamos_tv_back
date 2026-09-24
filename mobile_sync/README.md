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

La app tiene dos modos de trabajo:

1. **Manual** (con la app abierta): home / películas / series / anime con
   opciones (páginas, reemplazo, `content`). Corre dentro de un **foreground
   service** (`flutter_foreground_task`) que mantiene la CPU activa y muestra
   el avance; la pantalla queda encendida mientras dura (`wakelock_plus`).
2. **Automático** (segundo plano, aun con la app cerrada): cada trabajo
   (solo home, películas, series, anime) se puede programar cada 15 min – 24 h
   con las mismas opciones. El trabajo lo ejecuta **WorkManager** (Android) y
   al terminar se muestra una notificación local.
3. **Push del backend**: cuando GNULA no responde desde el servidor (está
   bloqueado), el backend pide a los celulares registrados que scrapeen un
   **content** puntual o una **búsqueda** (FCM, mensaje data-only). La app
   scrapea desde su IP residencial y sube el resultado por `/sync/ingest`.

## Requisitos

- Flutter SDK (https://docs.flutter.dev/get-started/install)
- Un celular Android (recommendado) o iOS con la app instalada
- La URL del backend (donde vive el panel de sincronización) y el token de
  ingesta (`SYNC_INGEST_TOKEN`) configurado en el servidor.
- Un proyecto de **Firebase** con Firebase Cloud Messaging habilitado:
  - Android: descargar `google-services.json` y ponerlo en
    `android/app/google-services.json` (**obligatorio**; sin él el build
    Android falla).
  - iOS: `GoogleService-Info.plist` en el proyecto Xcode + certificado/keys de
    APNs en la consola de Firebase.

## Crear el proyecto (una vez)

> Requisito previo para Android: el archivo `android/app/google-services.json`
> (ver Requisitos) debe existir antes del primer build.

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

Después de agregar las dependencias (nuevas: firebase, workmanager,
notificaciones) correr `flutter pub get`.

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
- **Solo home / Películas / Series / Anime**: subconjuntos.
- **SINCRONIZACIÓN AUTOMÁTICA**: activá por trabajo el íntervalo y las opciones
  (páginas, reemplazo, `content`).

## Backend (lo que necesita la app)

- `POST /sync/ingest` — auth por header `X-Sync-Token: <SYNC_INGEST_TOKEN>`.
  Acepta `type: home | movies | series | anime | search`. El tipo `search`
  recibe `{ type:'search', query, items }` (con `items[].id` con prefijo
  `gmov_`/`gser_`/`gani_`) y persiste en las colecciones v2 + invalida la
  caché de búsqueda.
- `POST /sync/push/register` — la app registra su token FCM
  (`{ deviceId, token, platform }`, auth `X-Sync-Token`).
- Hooks automáticos: `/content/:id` (cuando GNULA no responde) y `/search`
  (cuando un query no trae resultados de GNULA) disparan un mensaje FCM
  `veamos_sync_task` a todos los dispositivos registrados (data-only,
  coalescido 10 min). Requiere las env de Firebase admin:
  `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`,
  `FIREBASE_DATABASE_URL` (o `GOOGLE_APPLICATION_CREDENTIALS`).
- `SINCRONIZAR_TOKEN` y `SYNC_INGEST_TOKEN`: la ruta push acepta cualquiera de
  los dos como `X-Sync-Token`.

## Cómo funciona el flujo

1. La app scrapea el home de GNULA (banners + secciones) y lo sube.
2. Scrapea el listado `/ver/peliculas` (y `/ver/series`), y por cada título su
   detalle (poster, descripción, player, episodios — hasta 60 episodios por
   serie; el resto se resuelve bajo demanda al abrir el título).
3. Cada lote de detalle se sube a `POST /sync/ingest` con `enrich=true`: el
   backend guarda en las colecciones v2 (`gnulahd-movies` / `gnulahd-series`
   / `gnulahd-anime`) y mezcla servidores de PelisPlus/PelisPedia (o
   JKAnime/Latanime en anime).
4. Automático: WorkManager (Android) recalcula la próxima corrida con la
   frecuencia menor habilitada; dentro de la ventana de trabajo de Android se
   corren los jobs vencidos (bloqueo por job para no pisar el de la UI).
5. Push: mensaje data-only `{ kind:'veamos_sync_task', task:'content'|'search',
   id|query }`. En app abierta lo atiende `onMessage`; en segundo plano/cerrada
   lo atiende `FirebaseMessaging.onBackgroundMessage`.

## Limitaciones conocidas

- **Android — WorkManager** no es exacto: Android puede demorar hasta
  `frequency` en disparar y Doze puede pausar el trabajo largo. Para catálogos
  grandes es más confiable el **Sync completo** manual (foreground service).
- **iOS — BackgroundTasks** (vía workmanager) tiene ventanas de ~30 s por
  sesión y no hay periodicidad garantizada; el push FCM en segundo plano
  requiere configuración de APNs y `content-available`. El soporte preferido en
  iOS es el foreground service manual.
- **FCM en Android 13+**: hay que aceptar el permiso de notificaciones; sin
  permiso Android puede matar el trabajo en segundo plano.
- Para registrar el push, la app necesita el token FCM; si no hay red o falta
  `google-services.json`, el registro falla silenciosamente y la app funciona
  igual (manual + automático sin push).

## Referencia del scraper

Portado de `src/providers/gnulahd.ts` (Node/cheerio → Dart/package:html).
Mantiene: cookie jar + interstitial DDoS-Guard (`/?gnm=1`), rotación de
dominios, y la desofuscación del player (base64 + XOR clave `[103,78,55,100]`
= `'gN7d'`).