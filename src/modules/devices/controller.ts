import { FastifyRequest, FastifyReply } from 'fastify';
import { createDeviceCode, deleteDeviceCode, listDeviceCodes, registerDevice, unlinkDeviceCode } from '../../services/device-codes';
import { addAppVersion, activateAppVersion, deactivateAppVersion, getAppVersions, removeAppVersion } from '../../services/app-versions';
import { subscribeRealtime } from '../../services/realtime';

/** Stream SSE del panel: emite eventos 'codes' y 'versions' cuando la base
 *  cambia (código tomado por un dispositivo, versión activada, etc.). */
export async function deviceEventsHandler(request: FastifyRequest, reply: FastifyReply) {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write(': connected\n\n');
  const unsubscribe = subscribeRealtime((frame) => response.write(frame));
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
  request.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

export async function registerDeviceHandler(request: FastifyRequest, reply: FastifyReply) {
  const { code } = request.params as { code?: string };
  const body = request.body as { deviceId?: string; version?: string } | undefined;
  const deviceId = (body?.deviceId || '').trim() || (request.headers['x-device-id'] as string)?.trim() || '';
  const version = (body?.version || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return reply.status(400).send({ error: 'code_invalid', message: 'El código debe tener 6 dígitos' });
  }
  if (!deviceId) {
    return reply.status(400).send({ error: 'device_id_required', message: 'Falta el identificador único del dispositivo' });
  }
  if (!version) {
    return reply.status(400).send({ error: 'version_required', message: 'Falta la versión de la app (ej: 1.1.5)' });
  }
  let appCfg;
  try {
    appCfg = await getAppVersions();
  } catch (e: any) {
    return reply.status(500).send({ error: 'internal_error', message: e?.message || 'Error al validar la versión' });
  }
  if (!appCfg.activeVersions.length) {
    return reply.status(403).send({ error: 'no_active_version', message: 'No hay una versión activa configurada en el panel' });
  }
  if (!appCfg.activeVersions.includes(version)) {
    return reply.status(403).send({ error: 'version_invalid', message: `La versión ${version} no está activa (activas: ${appCfg.activeVersions.join(', ')})` });
  }
  try {
    const result = await registerDevice(code, deviceId);
    if (!result.ok) {
      return reply.status(result.status || 500).send({ error: result.codeKey || 'error', message: result.reason || 'Error' });
    }
    return reply.send({ ok: true, code: result.code, deviceId: result.deviceId });
  } catch (e: any) {
    return reply.status(500).send({ error: 'internal_error', message: e?.message || 'Error al registrar el dispositivo' });
  }
}

export async function listCodesHandler(_request: FastifyRequest, reply: FastifyReply) {
  try {
    const codes = await listDeviceCodes();
    return reply.send({ items: codes });
  } catch (e: any) {
    return reply.status(500).send({ error: 'internal_error', message: e?.message || 'Error al listar los códigos' });
  }
}

export async function createCodeHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { note?: string; code?: string } | undefined;
  try {
    const entry = await createDeviceCode(body?.note, body?.code);
    return reply.send({ ok: true, code: entry });
  } catch (e: any) {
    return reply.status(400).send({ error: 'create_failed', message: e?.message || 'Error al crear el código' });
  }
}

export async function deleteCodeHandler(request: FastifyRequest, reply: FastifyReply) {
  const { code } = request.params as { code?: string };
  if (!code || !/^\d{6}$/.test(code)) return reply.status(400).send({ error: 'code_invalid', message: 'El código debe tener 6 dígitos' });
  try {
    const deleted = await deleteDeviceCode(code);
    if (!deleted) return reply.status(404).send({ error: 'code_not_found', message: 'El código no existe' });
    return reply.send({ ok: true });
  } catch (e: any) {
    return reply.status(500).send({ error: 'internal_error', message: e?.message || 'Error al eliminar el código' });
  }
}

export async function unlinkCodeHandler(request: FastifyRequest, reply: FastifyReply) {
  const { code } = request.params as { code?: string };
  if (!code || !/^\d{6}$/.test(code)) return reply.status(400).send({ error: 'code_invalid', message: 'El código debe tener 6 dígitos' });
  try {
    const unlinked = await unlinkDeviceCode(code);
    if (!unlinked) return reply.status(404).send({ error: 'code_not_found', message: 'El código no existe' });
    return reply.send({ ok: true });
  } catch (e: any) {
    return reply.status(500).send({ error: 'internal_error', message: e?.message || 'Error al liberar el código' });
  }
}

export async function getVersionsHandler(_request: FastifyRequest, reply: FastifyReply) {
  try {
    const cfg = await getAppVersions();
    return reply.send(cfg);
  } catch (e: any) {
    return reply.status(500).send({ error: 'internal_error', message: e?.message || 'Error al listar versiones' });
  }
}

export async function addVersionHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as { version?: string } | undefined;
  try {
    const cfg = await addAppVersion(body?.version || '');
    return reply.send({ ok: true, ...cfg });
  } catch (e: any) {
    return reply.status(400).send({ error: 'add_failed', message: e?.message || 'Error al agregar la versión' });
  }
}

export async function activateVersionHandler(request: FastifyRequest, reply: FastifyReply) {
  const { version } = request.params as { version?: string };
  try {
    const cfg = await activateAppVersion(version || '');
    return reply.send({ ok: true, ...cfg });
  } catch (e: any) {
    return reply.status(400).send({ error: 'activate_failed', message: e?.message || 'Error al activar la versión' });
  }
}

export async function deactivateVersionHandler(request: FastifyRequest, reply: FastifyReply) {
  const { version } = request.params as { version?: string };
  try {
    const cfg = await deactivateAppVersion(version || '');
    return reply.send({ ok: true, ...cfg });
  } catch (e: any) {
    return reply.status(400).send({ error: 'deactivate_failed', message: e?.message || 'Error al desactivar la versión' });
  }
}

export async function removeVersionHandler(request: FastifyRequest, reply: FastifyReply) {
  const { version } = request.params as { version?: string };
  try {
    const cfg = await removeAppVersion(version || '');
    return reply.send({ ok: true, ...cfg });
  } catch (e: any) {
    return reply.status(400).send({ error: 'remove_failed', message: e?.message || 'Error al eliminar la versión' });
  }
}