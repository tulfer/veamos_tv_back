import { redisConfig } from '../config/redis';
import { logger } from '../utils/logger';

type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: string[]): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<'OK'>;
};

let redisClient: RedisClient | null = null;

export async function getRedisClient(): Promise<RedisClient | null> {
  if (redisClient) return redisClient;
  if (!redisConfig.enabled) return null;

  try {
    const { default: IORedis } = await import('ioredis');
    const client = new IORedis(redisConfig.url!, {
      keyPrefix: redisConfig.keyPrefix,
      lazyConnect: true,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
    }) as unknown as RedisClient;
    await (client as any).connect();
    redisClient = client;
    logger.info('Redis connected');
    return redisClient;
  } catch (error) {
    logger.warn({ error }, 'Redis unavailable, using memory cache only');
    return null;
  }
}

export async function redisGet<T>(key: string): Promise<T | null> {
  const client = await getRedisClient();
  if (!client) return null;
  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}

export async function redisSet(key: string, data: unknown, ttlSec = 300): Promise<void> {
  const client = await getRedisClient();
  if (!client) return;
  await client.set(key, JSON.stringify(data), 'EX', String(ttlSec));
}

export async function redisDel(key: string): Promise<void> {
  const client = await getRedisClient();
  if (!client) return;
  await client.del(key);
}
