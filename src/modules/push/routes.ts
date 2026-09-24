import { FastifyInstance } from 'fastify';
import { dispatchPushTaskHandler, listPushDevicesHandler, registerPushDeviceHandler } from './controller';

export async function pushRoutes(app: FastifyInstance) {
  app.post('/sync/push/register', registerPushDeviceHandler);
  app.get('/sync/push/devices', listPushDevicesHandler);
  app.post('/sync/push/task', dispatchPushTaskHandler);
}