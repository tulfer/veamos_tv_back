interface CacheEntry<T> {
  data: T;
  ttl: number;
  createdAt: number;
}

export class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private defaultTTL: number;

  constructor(defaultTTLMs = 300_000) {
    this.defaultTTL = defaultTTLMs;
    this.startCleanup();
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > entry.ttl) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs?: number): void {
    this.store.set(key, {
      data,
      ttl: ttlMs ?? this.defaultTTL,
      createdAt: Date.now(),
    });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  delByPattern(pattern: string): void {
    const regex = new RegExp(pattern.replace('*', '.*'));
    for (const key of this.store.keys()) {
      if (regex.test(key)) this.store.delete(key);
    }
  }

  flush(): void {
    this.store.clear();
  }

  private startCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store.entries()) {
        if (now - entry.createdAt > entry.ttl) this.store.delete(key);
      }
    }, 60_000);
  }
}

export const memoryCache = new MemoryCache();
