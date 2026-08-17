# Veamos TV Backend — Guía rápida para agentes

## Glosario (nombres que usa el usuario)

- **"panel de sincronización"** = la SPA React que se sirve en `/sync/app`
  (HTML: `frontend/index.html` → bundle `frontend/src/main.tsx`, estilos
  `frontend/src/styles.css`). Es el dashboard principal: tarjetas de Procesos,
  Refresh por proveedor, Agregar canales en vivo, Actualizar canales,
  Log de actualización, Backup de base de datos, Sincronizar ítem GNULA,
  Importar M3U e Importar canales de sitios web.
- **"mipanel"** = panel de administración de códigos de dispositivo y
  versiones de la app, servido en `/mipanel` (`frontend/mipanel.html` →
  `frontend/src/mipanel.tsx`).
- **"landing"** = página estática `public/landing.html`, servida en `/` y en
  `/v2/:code/app` (esta última protegida por el código de dispositivo).
- **"refresh por proveedor"** = `POST /live/channels/refresh-provider/:provider`
  (en `src/modules/live-tv/controller.ts`), resuelve de nuevo la URL de stream
  de canales guardados con `refreshUrl` + `proveedor`.

## Comandos

- Typecheck backend: `npx tsc --noEmit`
- Build del frontend (Vite multi-página → `public/dashboard`): `npm run build:client`
- El store local es no-op sin `DATABASE_URL`; la persistencia real se prueba tras
  desplegar en dokploy.

## Flujos clave

- Registro de dispositivo: `POST /v2/:code/device/register` con body
  `{ deviceId, version }`; la versión debe coincidir con la activa gestionada
  en mipanel (`/devices/versions`).
- Import M3U e import de sitios web: el backend nunca guarda estado del preview
  en memoria para el import; el frontend envía los canales seleccionados
  (`channels`) y el backend revalida y guarda.
