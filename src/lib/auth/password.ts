import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1).
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200, "Password is too long")
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9\W]/.test(p), "Include letters and at least one number or symbol");

export const hashPassword = (password: string) => hash(password, OPTS);

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}
