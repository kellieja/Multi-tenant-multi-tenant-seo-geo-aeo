import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY is required (openssl rand -base64 32)"),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET is required (openssl rand -base64 32)"),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  PAGESPEED_API_KEY: z.string().optional().default(""),
  SMTP_URL: z.string().optional().default(""),
  EMAIL_FROM: z.string().optional().default(""),
  CRAWLER_USER_AGENT: z.string().default("SearchOpsBot/1.0 (+https://searchops.app/bot)"),
  ALLOW_PRIVATE_NETWORK_FETCH: z.enum(["true", "false"]).default("false"),
  DEMO_MODE: z.enum(["true", "false"]).default("false"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Validated server environment. Throws a readable error on misconfiguration. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.ALLOW_PRIVATE_NETWORK_FETCH === "true") {
    throw new Error("ALLOW_PRIVATE_NETWORK_FETCH must not be enabled in production");
  }
  cached = parsed.data;
  return cached;
}

export const isDemoMode = () => env().DEMO_MODE === "true";
