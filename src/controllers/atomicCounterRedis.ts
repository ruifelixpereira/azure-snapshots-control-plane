import { DefaultAzureCredential } from '@azure/identity';
import { EntraIdCredentialsProviderFactory, REDIS_SCOPE_DEFAULT } from '@redis/entraid';
import { createClient, RedisClientType } from '@redis/client';

export class AtomicCounterRedis {

  private redis?: RedisClientType;
  private ready: Promise<void>;
  private key: string;

  constructor(redisEndpoint: string, key = "copy:counter") {
    this.key = key;

    // start async initialization and keep readiness promise
    this.ready = this.initRedisClient(redisEndpoint).then(client => {
      this.redis = client;
    }).catch((err) => {
      console.error('Failed to initialize AAD Redis client:', err);
      // rethrow so callers awaiting ready see the error
      throw err;
    });
  }

  private async initRedisClient(redisEndpoint: string): Promise<RedisClientType> {
    const credential = new DefaultAzureCredential();

    const provider = EntraIdCredentialsProviderFactory.createForDefaultAzureCredential({
      credential,
      scopes: REDIS_SCOPE_DEFAULT,
      options: {},
      tokenManagerConfig: {
        expirationRefreshRatio: 0.8
      }
    });

    const client = createClient({
      url: `rediss://${redisEndpoint}`,
      credentialsProvider: provider
    });

    client.on('error', (err) => {
      console.error('Redis client error', err);
    });

    await client.connect();
    return client;
  }

  private async ensureReady(): Promise<void> {
    return this.ready;
  }

  // Try to acquire slot; returns true if acquired
  async tryAcquire(limit = 100): Promise<boolean> {
    await this.ensureReady();
    const client = this.redis!;
    const val = await client.incr(this.key);
    if (val === 1) {
      // optional: set TTL to auto-release in case of crash
      await client.expire(this.key, 60 * 60 * 2);
    }
    if (val > limit) {
      await client.decr(this.key);
      return false;
    }
    return true;
  }

  async release(): Promise<void> {
    await this.ensureReady();
    const client = this.redis!;
    const val = await client.decr(this.key);
    if (val < 0) {
      await client.set(this.key, "0");
    }

  }

  async count(): Promise<number> {
    await this.ensureReady();
    const client = this.redis!;
    const v = await client.get(this.key);
    return Number(v || 0);
  }

  
  //async close(): Promise<void> {
  //  if (this.redis) {
  //    try { await this.redis.quit(); } catch { try { await this.redis.disconnect(); } catch {} }
  //  } else {
  //    // ensure ready rejection doesn't leave resources
  //    try { await this.ready; } catch { /* ignore */ }
  //  }
  //}
  
}

