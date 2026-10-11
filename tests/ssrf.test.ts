import { describe, expect, it } from "vitest";
import { assertSafeUrlShape, isPublicIp, UnsafeUrlError } from "@/lib/net/ssrf";
import { safeFetch } from "@/lib/net/safe-fetch";

describe("ssrf guard", () => {
  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe"]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicIp(ip), ip).toBe(true);
  });

  it("rejects dangerous URL shapes", () => {
    for (const u of [
      "file:///etc/passwd", "gopher://x.com", "http://localhost/", "http://127.0.0.1/", "http://[::1]/",
      "http://169.254.169.254/latest/meta-data", "http://user:pass@example.com/", "http://example.com:22/",
      "http://metadata.google.internal/", "http://intranet/", "http://0x7f000001/",
    ]) {
      expect(() => assertSafeUrlShape(u), u).toThrow(UnsafeUrlError);
    }
    expect(assertSafeUrlShape("https://example.com/path").hostname).toBe("example.com");
  });

  it("blocks hostnames that resolve to private addresses at connect time", async () => {
    // localtest.me style names resolve to 127.0.0.1; use a literal-free name via /etc/hosts-less trick:
    // "localhost." with trailing dot bypasses naive string checks but must still be blocked by DNS pinning.
    await expect(safeFetch("http://localhost./")).rejects.toThrow();
  });
});
