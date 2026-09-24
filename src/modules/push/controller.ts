import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../../config/env';
import { dispatchPushTask, listPushDevices, pushConfigured, registerPushDevice, PushTask, PushDevice } from '../../services/push';

/** Auth compartida: acepta el token de la app móvil o el del servicio
 *  "sincronizar" (cualquiera de los dos da derecho a registrar/despachar). */
function ingestAuthOk(request: FastifyRequest): boolean {
  const received = request.headers['x-sync-token'];
  if (typeof received !== 'string' || !received) return false;
  const expected = [env.SYNC_INGEST_TOKEN, env.SINCRONIZAR_TOKEN].map((t) => t?.trim()).filter((t): t is string => !!t);
  if (expected.length === 0) return false;
  return expected.includes(received);
}

export async function registerPushDeviceHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!ingestAuthOk(request)) {
    return reply.status(401).send({ ok: false, error: 'Token de ingesta inválido' });
  }
  const { deviceId, token, platform } = (request.body ?? {}) as Partial<PushDevice>;
  if (!deviceId || !token) {
    return reply.status(422).send({ ok: false, error: 'deviceId y token son obligatorios' });
  }
  const normalizedPlatform: PushDevice['platform'] =
    platform === 'android' || platform === 'ios' ? platform : 'other';
  await registerPushDevice({ deviceId, token, platform: normalizedPlatform });
  return reply.send({ ok: true });
}

export async function listPushDevicesHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!ingestAuthOk(request)) {
    return reply.status(401).send({ ok: false, error: 'Token de ingesta inválido' });
  }
  const devices = await listPushDevices();
  return reply.send({ ok: true, devices });
}

export async function dispatchPushTaskHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!ingestAuthOk(request)) {
    return reply.status(401).send({ ok: false, error: 'Token de ingesta inválido' });
  }
  if (!pushConfigured()) {
    return reply
      .status(503)
      .send({ ok: false, error: 'Push no configurado: faltan FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY (o GOOGLE_APPLICATION_CREDENTIALS)' });
  }

  const body = (request.body ?? {}) as Record<string, unknown>;
  const task = body.task;
  let pushTask: PushTask;

  if (task === 'content') {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) return reply.status(422).send({ ok: false, error: 'task content requiere id' });
    pushTask = { task: 'content', id };
  } else if (task === 'search') {
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query || query.length < 2) {
      return reply.status(422).send({ ok: false, error: 'task search requiere query (mín. 2 caracteres)' });
    }
    const type = body.type;
    pushTask = {
      task: 'search',
      query,
      type: type === 'movie' || type === 'series' || type === 'anime' ? type : undefined,
    };
  } else {
    return reply.status(422).send({ ok: false, error: 'task debe ser "content" o "search"' });
  }

  const result = await dispatchPushTask(pushTask);
  return reply.send({ ok: true, ...result });
}