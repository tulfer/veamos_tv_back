import { FastifyInstance } from 'fastify';
import {
  getChannelsHandler,
  getChannelDetailHandler,
  getGroupsHandler,
  getCountriesHandler,
  getValidationStatusHandler,
  getChatytvChannelHandler,
  getWsDeportesChannelHandler,
  getTvPorInternet2Handler,
  getCablevisionHdHandler,
  refreshExpiredChannelsHandler,
} from './controller';

export async function liveTVRoutes(app: FastifyInstance) {
  app.get('/live/channels', getChannelsHandler);
  app.get('/live/channels/:id', getChannelDetailHandler);
  app.get('/live/groups', getGroupsHandler);
  app.get('/live/countries', getCountriesHandler);
  app.get('/live/validation-status', getValidationStatusHandler);
  app.post('/live/channels/add/chatytv/:channel', getChatytvChannelHandler);
  app.post('/live/channels/add/wsdeportes/:parameter', getWsDeportesChannelHandler);
  app.post('/live/channels/add/tvporinternet2/:slug', getTvPorInternet2Handler);
  app.post('/live/channels/add/cablevisionhd/:slug', getCablevisionHdHandler);
  app.post('/live/channels/refresh-expired', refreshExpiredChannelsHandler);
}
