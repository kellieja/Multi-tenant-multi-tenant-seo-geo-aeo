import type { Role } from "@prisma/client";

export const PERMISSIONS = {
  "org:manage": ["OWNER", "ADMIN"],
  "members:manage": ["OWNER", "ADMIN"],
  "billing:manage": ["OWNER"],
  "integrations:manage": ["OWNER", "ADMIN", "MANAGER"],
  "websites:read": ["OWNER", "ADMIN", "MANAGER", "ANALYST", "CLIENT"],
  "websites:write": ["OWNER", "ADMIN", "MANAGER"],
  "websites:delete": ["OWNER", "ADMIN"],
  "audits:run": ["OWNER", "ADMIN", "MANAGER", "ANALYST"],
  "findings:write": ["OWNER", "ADMIN", "MANAGER", "ANALYST"],
  "tasks:write": ["OWNER", "ADMIN", "MANAGER", "ANALYST"],
  "keywords:write": ["OWNER", "ADMIN", "MANAGER", "ANALYST"],
  "backlinks:write": ["OWNER", "ADMIN", "MANAGER", "ANALYST"],
  "outreach:write": ["OWNER", "ADMIN", "MANAGER", "ANALYST"],
  "content:write": ["OWNER", "ADMIN", "MANAGER", "ANALYST"],
  "geo:write": ["OWNER", "ADMIN", "MANAGER", "ANALYST"],
  "automation:write": ["OWNER", "ADMIN", "MANAGER"],
  "approvals:decide": ["OWNER", "ADMIN", "MANAGER"],
  "reports:read": ["OWNER", "ADMIN", "MANAGER", "ANALYST", "CLIENT"],
  "reports:write": ["OWNER", "ADMIN", "MANAGER", "ANALYST"],
  "reports:approve": ["OWNER", "ADMIN", "MANAGER"],
  "audit-log:read": ["OWNER", "ADMIN"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = "You do not have permission to perform this action") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function assertCan(role: Role, permission: Permission) {
  if (!can(role, permission)) throw new ForbiddenError();
}

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  ANALYST: "Analyst",
  CLIENT: "Client (read-only portal)",
};
