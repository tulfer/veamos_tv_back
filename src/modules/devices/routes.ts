import { FastifyInstance } from 'fastify';
import { registerDeviceHandler, listCodesHandler, createCodeHandler, deleteCodeHandler, unlinkCodeHandler } from './controller';

export async function deviceRoutes(app: FastifyInstance) {
  // Endpoint público usado por la app cliente: recibe el código de 6 dígitos
  // y el número único del dispositivo. El primer dispositivo que registre un
  // código queda vinculado a él; los demás fallan.
  app.post('/v2/device/register', registerDeviceHandler);

  // API del panel /mipanel (administración de códigos).
  app.get('/devices/codes', listCodesHandler);
  app.post('/devices/codes', createCodeHandler);
  app.delete('/devices/codes/:code', deleteCodeHandler);
  app.post('/devices/codes/:code/unlink', unlinkCodeHandler);
}