import { FastifyInstance } from 'fastify';
import { registerDeviceHandler, listCodesHandler, createCodeHandler, deleteCodeHandler, unlinkCodeHandler } from './controller';

export async function deviceRoutes(app: FastifyInstance) {
  // Endpoint público usado por la app cliente: el código va en la ruta y el
  // body solo lleva el número único del dispositivo. El primer dispositivo que
  // registre un código queda vinculado a él; los demás fallan (409 code_taken).
  app.post('/v2/:code/device/register', registerDeviceHandler);

  // API del panel /mipanel (administración de códigos).
  app.get('/devices/codes', listCodesHandler);
  app.post('/devices/codes', createCodeHandler);
  app.delete('/devices/codes/:code', deleteCodeHandler);
  app.post('/devices/codes/:code/unlink', unlinkCodeHandler);
}