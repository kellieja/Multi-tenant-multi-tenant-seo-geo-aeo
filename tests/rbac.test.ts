import { describe, expect, it } from "vitest";
import { can } from "@/lib/auth/rbac";

describe("rbac", () => {
  it("restricts destructive and approval permissions", () => {
    expect(can("OWNER", "websites:delete")).toBe(true);
    expect(can("MANAGER", "websites:delete")).toBe(false);
    expect(can("ANALYST", "approvals:decide")).toBe(false);
    expect(can("MANAGER", "approvals:decide")).toBe(true);
    expect(can("ANALYST", "audits:run")).toBe(true);
  });
  it("client role is read-only", () => {
    expect(can("CLIENT", "websites:read")).toBe(true);
    expect(can("CLIENT", "reports:read")).toBe(true);
    for (const p of ["websites:write", "audits:run", "findings:write", "integrations:manage", "automation:write"] as const) {
      expect(can("CLIENT", p)).toBe(false);
    }
  });
});
