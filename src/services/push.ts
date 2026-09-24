import { getRow, setRow } from './store';
import { logger } from '../utils/logger';
import { env } from '../config/env';

/**
 * Coordinación con la app móvil vía FCM (Firebase Cloud Messaging).
 *
 * El backend (en dokploy) está bloqueado por DDoS-Guard para scrapear GNULA
 * directamente, pero la app Flutter corre desde la IP residencial del celular
 * y sí puede hacerlo. Cuando el backend necesita un contenido o una búsqueda
 * de GNULA que no puede resolver, enruta un "push task" a los dispositivos
 * registrados; la app scrapea y sube el resultado por `/sync/ingest`.
 *
 * Los tokens FCM se guardan en la tabla `store` bajo la clave 'push:devices'.
 * Se reutilizan las credenciales FIREBASE_* (las mismas que usa la migración
 * Firestore → Supabase); firebase-admin se carga de forma perezosa.
 */

export interface PushDevice {
  deviceId: string;
  token: string;
  platform: 'android' | 'ios' | 'other';
  updatedAt: number;
}

const DEVICES_KEY = 'push:devices';

/** Coalescing en memoria para no martillar los teléfonos con el MISMO pedido
 *  (idad/query) repetido en poco tiempo. */
const dispatchedKeys = new Map<string, number>();
const DISPATCH_TTL_MS = 10 * 60 * 1000;

export async function listPushDevices(): Promise<PushDevice[]> {
  const data = await getRow<PushDevice[]>(DEVICES_KEY);
  if (!data || !Array.isArray(data)) return [];
  return data;
}

/** Registra (o actualiza) el token FCM de un dispositivo para recibir tasks. */
export async function registerPushDevice(
  device: Omit<PushDevice, 'updatedAt'>,
): Promise<void> {
  const devices = await listPushDevices();
  const idx = devices.findIndex((d) => d.deviceId === device.deviceId);
  if (idx >= 0) {
    devices[idx] = { ...devices[idx], ...device, updatedAt: Date.now() };
  } else {
    devices.push({ ...device, updatedAt: Date.now() });
  }
  await setRow(DEVICES_KEY, devices);
  logger.info({ deviceId: device.deviceId, platform: device.platform }, 'push: dispositivo registrado');
}

export async function removePushDevice(deviceId: string): Promise<void> {
  const devices = await listPushDevices();
  const next = devices.filter((d) => d.deviceId !== deviceId);
  if (next.length !== devices.length) {
    await setRow(DEVICES_KEY, next);
  }
}

function shouldDispatch(key: string): boolean {
  const now = Date.now();
  const last = dispatchedKeys.get(key) || 0;
  if (now - last < DISPATCH_TTL_MS) return false;
  dispatchedKeys.set(key, now);
  // Mantener el mapa acotado.
  if (dispatchedKeys.size > 500) {
    for (const [k, t] of dispatchedKeys) {
      if (now - t > DISPATCH_TTL_MS) dispatchedKeys.delete(k);
    }
  }
  return true;
}

async function initFirebase(): Promise<typeof import('firebase-admin')> {
  const fb = (await import('firebase-admin')).default as typeof import('firebase-admin');
  if (fb.apps.length === 0) {
    const projectId = env.FIREBASE_PROJECT_ID || 'veamos-tv';
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      fb.initializeApp({
        credential: fb.credential.applicationDefault(),
        projectId,
        databaseURL: env.FIREBASE_DATABASE_URL,
      });
    } else {
      const clientEmail = env.FIREBASE_CLIENT_EMAIL;
      const privateKey = env.FIREBASE_PRIVATE_KEY;
      if (!clientEmail || !privateKey) {
        throw new Error(
          'Falta una credencial de Firebase admin para push (GOOGLE_APPLICATION_CREDENTIALS o FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY).',
        );
      }
      fb.initializeApp({
        credential: fb.credential.cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
        databaseURL: env.FIREBASE_DATABASE_URL,
      });
    }
  }
  return fb;
}

export interface PushTaskContent {
  task: 'content';
  id: string;
}

export interface PushTaskSearch {
  task: 'search';
  query: string;
  type?: 'movie' | 'series' | 'anime';
}

export type PushTask = PushTaskContent | PushTaskSearch;

/** Lanza un task FCM a todos los dispositivos registrados (data-only, sin
 *  notificación visible: la app lo ejecuta en segundo plano y sube el
 *  resultado). Devuelve cuántos mensajes se encolaron.
 *
 *  Coalesce por clave para no repetir el mismo pedido en 10 minutos.
 */
export async function dispatchPushTask(task: PushTask): Promise<{ queued: number; devices: number }> {
  const devices = await listPushDevices();
  if (devices.length === 0) return { queued: 0, devices: 0 };

  const key =
    task.task === 'content'
      ? `content:${task.id}`
      : `search:${task.type || 'all'}:${task.query.trim().toLowerCase()}`;
  if (!shouldDispatch(key)) return { queued: 0, devices: devices.length };

  const data: Record<string, string> = {
    kind: 'veamos_sync_task',
    task: task.task,
  };
  if (task.task === 'content') {
    data.id = task.id;
  } else {
    data.query = task.query;
    if (task.type) data.type = task.type;
  }

  try {
    const fb = await initFirebase();
    const messaging = fb.messaging();
    const tokens = devices.map((d) => d.token).filter((t) => t && t.length > 8);
    if (tokens.length === 0) return { queued: 0, devices: 0 };

    const result = await messaging.sendEachForMulticast({
      tokens,
      data,
      android: { priority: 'high' },
      apns: { headers: { 'apns-push-type': 'background', 'apns-priority': '5' } },
    });

    const invalid: string[] = [];
    result.responses.forEach((res, idx) => {
      if (res.success) return;
      const code = res.error?.code || '';
      if (
        code.startsWith('messaging/invalid-registration') ||
        code.endsWith('registration-token-not-registered')
      ) {
        invalid.push(tokens[idx]);
      }
    });
    if (invalid.length > 0) {
      const next = devices.filter((d) => !invalid.includes(d.token));
      await setRow(DEVICES_KEY, next);
      logger.warn({ removed: invalid.length }, 'push: se quitaron tokens FCM inválidos');
    }

    logger.info(
      { task: task.task, success: result.successCount, failed: result.failureCount },
      'push: task despachado a la app móvil',
    );
    return { queued: result.successCount, devices: devices.length };
  } catch (error) {
    logger.error({ error: (error as Error).message, task: task.task }, 'push: envío FCM falló');
    return { queued: 0, devices: devices.length };
  }
}

export function pushConfigured(): boolean {
  return !!(env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) || !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
}