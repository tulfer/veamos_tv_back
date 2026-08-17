import { FastifyInstance } from 'fastify';
import { registerDeviceHandler, listCodesHandler, createCodeHandler, deleteCodeHandler, unlinkCodeHandler, getVersionsHandler, addVersionHandler, activateVersionHandler, removeVersionHandler } from './controller';

export async function deviceRoutes(app: FastifyInstance) {
  // Endpoint público usado por la app cliente: el código va en la ruta y el
  // body lleva el número único del dispositivo y la versión de la app (que
  // debe coincidir con la versión activa configurada en /mipanel). El primer
  // dispositivo que registre un código queda vinculado a él; los demás fallan.
  app.post('/v2/:code/device/register', registerDeviceHandler);

  // API del panel /mipanel (administración de códigos).
  app.get('/devices/codes', listCodesHandler);
  app.post('/devices/codes', createCodeHandler);
  app.delete('/devices/codes/:code', deleteCodeHandler);
  app.post('/devices/codes/:code/unlink', unlinkCodeHandler);

  // API del panel /mipanel (versiones de la app habilitadas/activa).
  app.get('/devices/versions', getVersionsHandler);
  app.post('/devices/versions', addVersionHandler);
  app.post('/devices/versions/:version/activate', activateVersionHandler);
  app.delete('/devices/versions/:version', removeVersionHandler);
}