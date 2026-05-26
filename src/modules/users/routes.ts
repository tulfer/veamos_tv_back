import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../middleware/auth';
import * as ctrl from './controller';

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.get('/users/me', ctrl.getOrCreateUserHandler);
  app.get('/users/profiles', ctrl.getProfilesHandler);
  app.post('/users/profiles', ctrl.createProfileHandler);

  app.get('/users/:profileId/favorites', ctrl.getFavoritesHandler);
  app.post('/users/:profileId/favorites', ctrl.addFavoriteHandler);
  app.delete('/users/:profileId/favorites/:itemId', ctrl.removeFavoriteHandler);

  app.get('/users/:profileId/continue-watching', ctrl.getContinueWatchingHandler);
  app.post('/users/:profileId/continue-watching', ctrl.upsertContinueWatchingHandler);

  app.get('/users/:profileId/history', ctrl.getHistoryHandler);
  app.get('/users/:profileId/recommendations', ctrl.getRecommendationsHandler);
}
