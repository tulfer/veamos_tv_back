import { FastifyInstance } from 'fastify';
import { registerDeviceHandler, listCodesHandler, createCodeHandler, deleteCodeHandler, unlinkCodeHandler, getVersionsHandler, addVersionHandler, activateVersionHandler, deactivateVersionHandler, removeVersionHandler, deviceEventsHandler } from './controller';

export async function deviceRoutes(app: FastifyInstance) {
  // Endpoint público usado por la app cliente: el código va en la ruta y el
  // body lleva el número único del dispositivo y la versión de la app (que
  // debe estar entre las versiones activas configuradas en /mipanel). El
  // primer dispositivo que registre un código queda vinculado a él; los demás
  // fallan.
  app.post('/v2/:code/device/register', registerDeviceHandler);

  // API del panel /mipanel (administración de códigos).
  app.get('/devices/codes', listCodesHandler);
  app.post('/devices/codes', createCodeHandler);
  app.delete('/devices/codes/:code', deleteCodeHandler);
  app.post('/devices/codes/:code/unlink', unlinkCodeHandler);

  // API del panel /mipanel (versiones de la app habilitadas/activas).
  // Puede haber más de una versión activa a la vez.
  app.get('/devices/versions', getVersionsHandler);
  app.post('/devices/versions', addVersionHandler);
  app.post('/devices/versions/:version/activate', activateVersionHandler);
  app.post('/devices/versions/:version/deactivate', deactivateVersionHandler);
  app.delete('/devices/versions/:version', removeVersionHandler);

  // Stream SSE: el panel se actualiza cuando la base cambia (código tomado,
  // última conexión, versión activada...), sin polling.
  app.get('/devices/events', deviceEventsHandler);
}