import { prisma } from "@/lib/db/client";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

const withTimeout = <T,>(p: Promise<T>, ms = 3000) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/**
 * Unauthenticated health check for load balancers and uptime monitors.
 * Returns only up/down states, never versions, hostnames or error details.
 * 200 when the database and Redis respond; the worker state is informational
 * (the web app keeps serving if the worker is down, but jobs won't run).
 */
export async function GET() {
  const [db, cache, beat] = await Promise.all([
    withTimeout(prisma.$queryRaw`SELECT 1`).then(() => true, () => false),
    withTimeout(redis().ping()).then((r) => r === "PONG", () => false),
    withTimeout(redis().get("worker:heartbeat")).then((v) => (v ? Number(v) : null), () => null),
  ]);
  const worker = beat == null ? "down" : Date.now() - beat < 120_000 ? "up" : "stale";
  const ok = db && cache;
  return Response.json({ ok, database: db ? "up" : "down", redis: cache ? "up" : "down", worker }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
