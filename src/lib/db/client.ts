import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Unscoped Prisma client. Only use for identity tables (User, Session,
 * Organization lookups) and system jobs that set tenant scope explicitly.
 * Tenant data access must go through `tenantDb(orgId)`.
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
