import Redis from "ioredis";
import pino from "pino";

const logger = pino({ name: "redis" });

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_URL =
  process.env.REDIS_URL?.trim() || DEFAULT_REDIS_URL;

// ioredis ESM default export may be the class or a namespace depending on TS config.
// Use `any` for the stored client to avoid type-level incompatibilities.
let _client: any = null;

export function getRedisClient(): any {
  if (!_client) {
    _client = new (Redis as any)(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy(times: number) {
        const delay = Math.min(times * 200, 5000);
        logger.warn({ attempt: times, delayMs: delay }, "Redis reconnecting");
        return delay;
      },
    });
    _client.on("connect", () => logger.info("Redis connected"));
    _client.on("error", (err: Error) => logger.error({ err }, "Redis error"));
  }
  return _client;
}

/** BullMQ needs a factory that returns new connections */
export function createRedisConnection(): any {
  return new (Redis as any)(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export function getRedisUrl(): string {
  return REDIS_URL;
}

export async function isRedisReachable(timeoutMs = 1000): Promise<boolean> {
  const probe = new (Redis as any)(REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: timeoutMs,
    lazyConnect: true,
    retryStrategy: () => null,
  });

  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    try {
      await probe.quit();
    } catch {
      probe.disconnect();
    }
  }
}

export async function shutdownRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
    logger.info("Redis disconnected");
  }
}
