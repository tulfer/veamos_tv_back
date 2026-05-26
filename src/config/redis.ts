import { env } from './env';

export const redisConfig = {
  url: env.REDIS_URL,
  enabled: !!env.REDIS_URL,
  keyPrefix: 'veamos:',
  defaultTTL: 300,
};
