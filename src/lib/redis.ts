import IORedis from "ioredis";

const g = globalThis as unknown as { redis?: IORedis };

export function redis(): IORedis {
  if (!g.redis) {
    g.redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: true,
      lazyConnect: false,
    });
    g.redis.on("error", (e) => console.error("[redis]", e.message));
  }
  return g.redis;
}
