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
  getTvenvivo2Handler,
  getCablevisionHdHandler,
  getSenalColombiaChannelHandler,
  getVertvCableChannelHandler,
  refreshExpiredChannelsHandler,
  refreshAllChannelsHandler,
  refreshByProviderHandler,
  updateChannelHandler,
  refreshChannelHandler,
  internalExtractHandler,
  getChannelsCountHandler,
} from './controller';

export async function liveTVRoutes(app: FastifyInstance) {
  app.get('/live/channels', getChannelsHandler);
  app.get('/live/channels/count', getChannelsCountHandler);
  app.get('/live/channels/:id', getChannelDetailHandler);
  app.patch('/live/channels/:id', updateChannelHandler);
  app.get('/live/groups', getGroupsHandler);
  app.get('/live/countries', getCountriesHandler);
  app.get('/live/validation-status', getValidationStatusHandler);
  app.post('/live/channels/add/chatytv/:channel', getChatytvChannelHandler);
  app.post('/live/channels/add/wsdeportes/:parameter', getWsDeportesChannelHandler);
  app.post('/live/channels/add/tvporinternet2/:slug', getTvPorInternet2Handler);
  app.post('/live/channels/add/tvenvivo2/:slug', getTvenvivo2Handler);
  app.post('/live/channels/add/cablevisionhd/:slug', getCablevisionHdHandler);
  app.post('/live/channels/add/senalcolombia/:slug', getSenalColombiaChannelHandler);
  app.post('/live/channels/add/vertvcable/:slug', getVertvCableChannelHandler);
  app.post('/live/channels/refresh-expired', refreshExpiredChannelsHandler);
  app.post('/live/channels/refresh-all', refreshAllChannelsHandler);
  app.post('/live/channels/refresh-provider/:provider', refreshByProviderHandler);
  app.post('/live/channels/refresh', refreshChannelHandler);
  app.post('/internal/extract', internalExtractHandler);
}
