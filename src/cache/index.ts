import { memoryCache } from './memory';
import { redisGet, redisSet, redisDel } from './redis';
import { logger } from '../utils/logger';

export { memoryCache } from './memory';
export { redisGet, redisSet, redisDel, getRedisClient } from './redis';

export async function getCachedOrFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSec = 300,
): Promise<T> {
  const ttlMs = ttlSec * 1000;

  const fromMemory = memoryCache.get<T>(key);
  if (fromMemory) return fromMemory;

  const fromRedis = await redisGet<T>(key);
  if (fromRedis) {
    memoryCache.set(key, fromRedis, ttlMs);
    return fromRedis;
  }

  logger.debug({ key }, 'Cache miss, fetching data');
  const data = await fetcher();

  memoryCache.set(key, data, ttlMs);
  await redisSet(key, data, ttlSec);

  return data;
}

export async function invalidateCache(key: string): Promise<void> {
  memoryCache.del(key);
  await redisDel(key);
}

export async function invalidateCacheByPattern(pattern: string): Promise<void> {
  memoryCache.delByPattern(pattern);
}
