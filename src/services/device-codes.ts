import { getRowStrict, setRow, tryAcquireLock, releaseLock } from './store';
import { broadcastRealtime } from './realtime';
import { logger } from '../utils/logger';

/**
 * Sistema de códigos de 6 dígitos para controlar qué dispositivos pueden
 * consumir la API /v2/<codigo>/...
 *
 * Un código es creado desde el panel (/mipanel) y queda "libre" hasta que el
 * PRIMER dispositivo lo registra (POST /v2/device/register con { code, deviceId }).
 * A partir de ahí el código queda vinculado a ese dispositivo para siempre:
 * cualquier otro deviceId que intente registrarlo falla con code_taken.
 *
 * Se guarda en la tabla `store` bajo la clave 'device:codes'.
 */

export interface DeviceCode {
  code: string;
  note: string;
  enabled: boolean;
  deviceId: string | null;
  createdAt: number;
  boundAt: number | null;
  lastSeenAt: number | null;
}

const KEY = 'device:codes';
const lastSeenThrottle = new Map<string, number>();

export async function listDeviceCodes(): Promise<DeviceCode[]> {
  const data = await getRowStrict<DeviceCode[]>(KEY);
  if (!data || !Array.isArray(data)) return [];
  return data;
}

async function saveDeviceCodes(codes: DeviceCode[]): Promise<void> {
  await setRow(KEY, codes);
  // El panel /mipanel se entera al instante (código tomado, liberado, etc.).
  broadcastRealtime('codes');
}

function randomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function createDeviceCode(note?: string, customCode?: string): Promise<DeviceCode> {
  const codes = await listDeviceCodes();
  const existing = new Set(codes.map((c) => c.code));
  let code = (customCode || '').trim();
  if (code) {
    if (!/^\d{6}$/.test(code)) throw new Error('El código debe tener exactamente 6 dígitos');
    if (existing.has(code)) throw new Error('El código ya existe');
  } else {
    code = randomCode();
    for (let i = 0; i < 50 && existing.has(code); i++) code = randomCode();
    if (existing.has(code)) throw new Error('No se pudo generar un código único');
  }
  const entry: DeviceCode = {
    code,
    note: (note || '').trim(),
    enabled: true,
    deviceId: null,
    createdAt: Date.now(),
    boundAt: null,
    lastSeenAt: null,
  };
  await saveDeviceCodes([...codes, entry]);
  return entry;
}

export async function deleteDeviceCode(code: string): Promise<boolean> {
  const codes = await listDeviceCodes();
  const next = codes.filter((c) => c.code !== code);
  if (next.length === codes.length) return false;
  await saveDeviceCodes(next);
  return true;
}

export async function unlinkDeviceCode(code: string): Promise<boolean> {
  const codes = await listDeviceCodes();
  const target = codes.find((c) => c.code === code);
  if (!target) return false;
  target.deviceId = null;
  target.boundAt = null;
  await saveDeviceCodes(codes);
  return true;
}

export interface RegisterResult {
  ok: boolean;
  code?: string;
  deviceId?: string;
  status?: number;
  codeKey?: string;
  reason?: string;
}

/**
 * Vincula el código al primer dispositivo que lo registre.
 * Idempotente para el mismo deviceId; falla (code_taken) si otro deviceId
 * intenta registrarlo. Usa candado atómico para evitar carreras entre
 * instancias (dos dispositivos registrando el mismo código a la vez).
 */
export async function registerDevice(code: string, deviceId: string): Promise<RegisterResult> {
  const lockKey = `device:code:lock:${code}`;
  const acquired = await tryAcquireLock(lockKey, deviceId, 10_000);
  if (!acquired) {
    return { ok: false, status: 429, codeKey: 'busy', reason: 'Registro en curso, inténtalo de nuevo' };
  }
  try {
    const codes = await listDeviceCodes();
    const target = codes.find((c) => c.code === code);
    if (!target) {
      return { ok: false, status: 403, codeKey: 'code_not_found', reason: 'Código no registrado' };
    }
    if (!target.enabled) {
      return { ok: false, status: 403, codeKey: 'code_disabled', reason: 'Código deshabilitado' };
    }
    if (target.deviceId) {
      if (target.deviceId !== deviceId) {
        return { ok: false, status: 409, codeKey: 'code_taken', reason: 'El código ya está vinculado a otro dispositivo' };
      }
      return { ok: true, code, deviceId };
    }
    target.deviceId = deviceId;
    target.boundAt = Date.now();
    target.lastSeenAt = Date.now();
    await saveDeviceCodes(codes);
    return { ok: true, code, deviceId };
  } finally {
    await releaseLock(lockKey, deviceId);
  }
}

/**
 * Valida el código en cada request a /v2/:code/*. Si el cliente envía su
 * deviceId (header x-device-id o query deviceId) además verifica que sea el
 * dispositivo vinculado. Actualiza lastSeenAt con throttling de 30s.
 */
export async function verifyDeviceCode(code: string | undefined, deviceId?: string): Promise<{ ok: boolean; status?: number; reason?: string }> {
  if (!code || !/^\d{6}$/.test(code)) {
    return { ok: false, status: 400, reason: 'Código inválido (deben ser 6 dígitos)' };
  }
  let codes: DeviceCode[];
  try {
    codes = await listDeviceCodes();
  } catch (e: any) {
    logger.error({ error: e?.message }, 'device-codes: verify read failed');
    return { ok: false, status: 500, reason: 'Error interno al validar el código' };
  }
  const target = codes.find((c) => c.code === code);
  if (!target) return { ok: false, status: 403, reason: 'Código no registrado' };
  if (!target.enabled) return { ok: false, status: 403, reason: 'Código deshabilitado' };
  if (!target.deviceId) return { ok: false, status: 403, reason: 'Código sin dispositivo vinculado' };
  if (deviceId && deviceId !== target.deviceId) {
    return { ok: false, status: 403, reason: 'Código vinculado a otro dispositivo' };
  }
  const now = Date.now();
  const last = lastSeenThrottle.get(code) || 0;
  if (now - last > 30_000) {
    lastSeenThrottle.set(code, now);
    target.lastSeenAt = now;
    saveDeviceCodes(codes).catch((err) => {
      logger.error({ error: err?.message }, 'device-codes: lastSeen update failed');
    });
  }
  return { ok: true };
}