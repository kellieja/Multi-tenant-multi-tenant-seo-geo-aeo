import { describe, expect, it } from "vitest";
import { createWebsite, importWebsitesCsv, listWebsites, setWebsiteStatus, updateWebsiteSettings, readSettings } from "@/server/websites";
import { normalizeSiteUrl, normalizeUrl } from "@/lib/url";
import { makeContext } from "./helpers";

describe("websites", () => {
  it("normalises URLs", () => {
    expect(normalizeSiteUrl("WWW.Example.com/")).toEqual({ baseUrl: "https://www.example.com", domain: "example.com" });
    expect(normalizeUrl("https://Example.com:443/a?utm_source=x&b=2&a=1#top")).toBe("https://example.com/a?a=1&b=2");
    expect(() => normalizeSiteUrl("not a url")).toThrow();
  });

  it("creates, dedupes, filters, pauses and archives", async () => {
    const ctx = await makeContext("MANAGER");
    await createWebsite(ctx, { name: "One", url: "one.example.com", tags: "retail, uk", folder: "Retail" });
    const two = await createWebsite(ctx, { name: "Two", url: "two.example.com" });
    await expect(createWebsite(ctx, { name: "dup", url: "https://www.one.example.com" })).rejects.toThrow(/already/);
    expect((await listWebsites(ctx, { q: "two" })).rows).toHaveLength(1);
    expect((await listWebsites(ctx, { folder: "Retail" })).rows[0].name).toBe("One");
    await setWebsiteStatus(ctx, two.id, "ARCHIVED");
    expect((await listWebsites(ctx, {})).total).toBe(1);
    expect((await listWebsites(ctx, { status: "ALL" })).total).toBe(2);
  });

  it("validates per-site settings", async () => {
    const ctx = await makeContext("OWNER");
    const site = await createWebsite(ctx, { name: "S", url: "settings.example.com" });
    const updated = await updateWebsiteSettings(ctx, site.id, { maxPages: 50, crawlSchedule: "0 3 * * 1" });
    expect(readSettings(updated.settings).maxPages).toBe(50);
    await expect(updateWebsiteSettings(ctx, site.id, { crawlSchedule: "every tuesday" })).rejects.toThrow(/cron/);
    await expect(updateWebsiteSettings(ctx, site.id, { maxPages: 0 })).rejects.toThrow();
  });

  it("imports CSV rows and reports skipped rows", async () => {
    const ctx = await makeContext("OWNER");
    const csv = "name,url,client,tags,cms\nAlpha,alpha.example.com,Acme,a;b,wordpress\nBad,not a url,,,\nAlpha again,alpha.example.com,,,";
    const res = await importWebsitesCsv(ctx, csv);
    expect(res.created).toBe(1);
    expect(res.skipped.map((s) => s.row)).toEqual([3, 4]);
    const site = (await listWebsites(ctx, {})).rows[0];
    expect(site.cmsType).toBe("WORDPRESS");
    expect(site.client?.name).toBe("Acme");
    expect(site.tags).toEqual(["a", "b"]);
  });
});
