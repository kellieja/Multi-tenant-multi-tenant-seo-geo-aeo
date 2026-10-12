import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, signPayload, verifyPayload, maskSecret } from "@/lib/crypto";

describe("crypto", () => {
  it("round-trips secrets and never stores plaintext", () => {
    const enc = encryptSecret({ apiKey: "sk-live-123456" });
    expect(enc).not.toContain("sk-live");
    expect(decryptSecret<{ apiKey: string }>(enc).apiKey).toBe("sk-live-123456");
  });
  it("detects tampering", () => {
    const enc = encryptSecret("hello");
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
  it("signs and verifies payloads with expiry", () => {
    const t = signPayload({ orgId: "o1" }, 60);
    expect(verifyPayload<{ orgId: string }>(t)?.orgId).toBe("o1");
    expect(verifyPayload(t.slice(0, -2) + "xx")).toBeNull();
    expect(verifyPayload(signPayload({ a: 1 }, -1))).toBeNull();
  });
  it("masks secrets", () => expect(maskSecret("abcdefgh")).toBe("••••efgh"));
});
