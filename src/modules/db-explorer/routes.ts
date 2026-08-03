import { FastifyInstance } from 'fastify';
import {
  dbExplorerHandler,
  listCollectionsHandler,
  getCollectionHandler,
  setPathHandler,
  deletePathHandler,
} from './controller';

/**
 * Explorador de Base de Datos (estilo Firestore Console).
 *
 *  GET    /db                          -> página HTML (requiere ?code=1992)
 *  GET    /db/collections              -> lista de filas de la tabla store
 *  GET    /db/collection/:key          -> valor jsonb de una fila
 *  PATCH  /db/collection/:key          -> { path, value } actualiza/agrega (x-admin-code)
 *  DELETE /db/collection/:key          -> { path } elimina campo/ítem; { full: true } elimina la fila (x-admin-code)
 */
export async function dbExplorerRoutes(app: FastifyInstance) {
  app.get('/db', dbExplorerHandler);
  app.get('/db/collections', listCollectionsHandler);
  app.get('/db/collection/:key', getCollectionHandler);
  app.patch('/db/collection/:key', setPathHandler);
  app.delete('/db/collection/:key', deletePathHandler);
}
