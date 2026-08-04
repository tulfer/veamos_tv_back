import { FastifyInstance } from 'fastify';
import { playerHandler } from './controller';

export async function playerRoutes(app: FastifyInstance) {
  app.get('/player', playerHandler);
}
