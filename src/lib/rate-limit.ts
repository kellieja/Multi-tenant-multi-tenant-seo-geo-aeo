import { redis } from "./redis";

export class RateLimitError extends Error {
  status = 429;
  constructor(public retryAfterSeconds: number) {
    super(`Too many requests. Try again in ${retryAfterSeconds}s.`);
    this.name = "RateLimitError";
  }
}

/**
 * Fixed-window limiter backed by Redis. If Redis is unreachable the limiter
 * fails closed for auth endpoints (pass failOpen=false) and open elsewhere.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number, failOpen = true) {
  const bucket = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  try {
    const r = redis();
    const count = await r.incr(bucket);
    if (count === 1) await r.expire(bucket, windowSeconds);
    if (count > limit) throw new RateLimitError(windowSeconds);
    return { remaining: limit - count };
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    if (!failOpen) throw new RateLimitError(windowSeconds);
    return { remaining: limit };
  }
}
