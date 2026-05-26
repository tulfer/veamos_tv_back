import { FastifyInstance } from 'fastify';
import { loginHandler, firebaseLoginHandler, refreshHandler, meHandler } from './controller';
import { authMiddleware } from '../../middleware/auth';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', loginHandler);
  app.post('/auth/firebase', firebaseLoginHandler);
  app.post('/auth/refresh', refreshHandler);
  app.get('/auth/me', { preHandler: [authMiddleware] }, meHandler);
}
