import { FastifyRequest, FastifyReply } from 'fastify';
import { DASHBOARD_CODE, generateCodeEntryPage } from '../sync/controller';
import { generateDbExplorerPage } from './ui';
import {
  listStoreKeys,
  loadCollectionRaw,
  saveCollectionRaw,
  deleteCollectionRaw,
  applyPathSet,
  applyPathDelete,
  parsePathSegments,
} from './service';

function isAdminRequest(request: FastifyRequest): boolean {
  const code = request.headers['x-admin-code'];
  return typeof code === 'string' && code === DASHBOARD_CODE;
}

export async function dbExplorerHandler(request: FastifyRequest, reply: FastifyReply) {
  const query = request.query as { code?: string };
  if (query.code !== DASHBOARD_CODE) {
    return reply.type('text/html').send(generateCodeEntryPage());
  }
  return reply.type('text/html').send(generateDbExplorerPage());
}

export async function listCollectionsHandler(_request: FastifyRequest, reply: FastifyReply) {
  const keys = await listStoreKeys();
  return reply.send(keys);
}

export async function getCollectionHandler(request: FastifyRequest, reply: FastifyReply) {
  const { key } = request.params as any;
  if (!key || typeof key !== 'string') {
    return reply.status(400).send({ error: 'key is required' });
  }
  const value = await loadCollectionRaw(key);
  if (value === null) {
    return reply.status(404).send({ error: `Key not found: ${key}` });
  }
  return reply.send(value);
}

export async function setPathHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!isAdminRequest(request)) {
    return reply.status(403).send({ error: 'Forbidden: x-admin-code inválido' });
  }
  const { key } = request.params as any;
  const body = (request.body || {}) as { path?: unknown; value?: unknown };
  if (!key || typeof key !== 'string') {
    return reply.status(400).send({ error: 'key is required' });
  }
  const segments = parsePathSegments(body.path);
  if (!segments) {
    return reply.status(400).send({ error: 'path debe ser un array de segmentos (string|number)' });
  }
  const root = await loadCollectionRaw(key);
  if (root === null) {
    return reply.status(404).send({ error: `Key not found: ${key}` });
  }
  const value = body.value === undefined ? null : body.value;
  const updated = applyPathSet(root, segments, value);
  await saveCollectionRaw(key, updated);
  return reply.send({ ok: true, key, path: segments, value: updated });
}

export async function deletePathHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!isAdminRequest(request)) {
    return reply.status(403).send({ error: 'Forbidden: x-admin-code inválido' });
  }
  const { key } = request.params as any;
  const body = (request.body || {}) as { path?: unknown; full?: boolean };
  if (!key || typeof key !== 'string') {
    return reply.status(400).send({ error: 'key is required' });
  }

  // body.full = true elimina la fila completa de la tabla store
  if (body.full === true) {
    await deleteCollectionRaw(key);
    return reply.send({ ok: true, key, deleted: true, full: true });
  }

  const segments = parsePathSegments(body.path);
  if (!segments) {
    return reply.status(400).send({ error: 'path debe ser un array de segmentos (string|number)' });
  }
  const root = await loadCollectionRaw(key);
  if (root === null) {
    return reply.status(404).send({ error: `Key not found: ${key}` });
  }
  const updated = applyPathDelete(root, segments);
  if (updated !== root) {
    await saveCollectionRaw(key, updated);
  }
  return reply.send({ ok: true, key, path: segments, value: updated });
}
