import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/client";
import { tenantDb, TenantViolationError } from "@/lib/db/tenant";
import { createWebsite, listWebsites, getWebsite, updateWebsite, deleteWebsite } from "@/server/websites";
import { assertWebsiteAccess } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/rbac";
import { makeContext } from "./helpers";

describe("tenant isolation", () => {
  it("scoped client never returns another organization's rows", async () => {
    const a = await makeContext("OWNER");
    const b = await makeContext("OWNER");
    const siteA = await createWebsite(a, { name: "A", url: "a-site.example.com" });
    await createWebsite(b, { name: "B", url: "b-site.example.com" });

    expect((await listWebsites(a, {})).rows.map((r) => r.domain)).toEqual(["a-site.example.com"]);
    expect(await b.db.website.findUnique({ where: { id: siteA.id } })).toBeNull();
    expect(await b.db.website.count()).toBe(1);
    // update/delete by id from the wrong tenant must not touch the row
    await expect(b.db.website.update({ where: { id: siteA.id }, data: { name: "pwned" } })).rejects.toThrow();
    const res = await b.db.website.deleteMany({ where: { id: siteA.id } });
    expect(res.count).toBe(0);
    expect((await prisma.website.findUnique({ where: { id: siteA.id } }))?.name).toBe("A");
  });

  it("rejects writes that target another organization", async () => {
    const a = await makeContext("OWNER");
    const b = await makeContext("OWNER");
    await expect(
      a.db.client.create({ data: { organizationId: b.org.id, name: "Sneaky" } }),
    ).rejects.toBeInstanceOf(TenantViolationError);
    await expect(a.db.website.findMany({ where: { organizationId: b.org.id } })).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("service functions refuse cross-tenant website ids", async () => {
    const a = await makeContext("OWNER");
    const b = await makeContext("OWNER");
    const siteA = await createWebsite(a, { name: "A", url: "https://cross.example.com" });
    await expect(getWebsite(b, siteA.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateWebsite(b, siteA.id, { name: "x", url: "cross.example.com" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteWebsite(b, siteA.id, "cross.example.com")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("client-portal members only see their client's websites", async () => {
    const owner = await makeContext("OWNER");
    const acme = await owner.db.client.create({ data: { organizationId: owner.org.id, name: "Acme" } });
    const acmeSite = await createWebsite(owner, { name: "Acme", url: "acme.example.com", clientId: acme.id });
    const otherSite = await createWebsite(owner, { name: "Other", url: "other.example.com" });
    const client = await makeContext("CLIENT", { orgId: owner.org.id, clientId: acme.id });

    expect(client.websiteScope).toEqual([acmeSite.id]);
    expect((await listWebsites(client, {})).rows.map((r) => r.id)).toEqual([acmeSite.id]);
    await expect(assertWebsiteAccess(client, otherSite.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createWebsite(client, { name: "x", url: "x.example.com" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("tenantDb requires an org id", () => {
    expect(() => tenantDb("")).toThrow(TenantViolationError);
  });
});
