import { FastifyRequest, FastifyReply } from 'fastify';
import { createDeviceCode, deleteDeviceCode, listDeviceCodes, registerDevice, unlinkDeviceCode } from '../../services/device-codes';

export async function registerDeviceHandler(request: FastifyRequest, reply: FastifyReply) {
  const { code } = request.params as { code?: string };
  const body = request.body as { deviceId?: string } | undefined;
  const deviceId = (body?.deviceId || '').trim() || (request.headers['x-device-id'] as string)?.trim() || '';
  if (!/^\d{6}$/.test(code)) {
    return reply.status(400).send({ error: 'code_invalid', message: 'El código debe tener 6 dígitos' });
  }
  if (!deviceId) {
    return reply.status(400).send({ error: 'device_id_required', message: 'Falta el identificador único del dispositivo' });
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