import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    // 'unsafe-inline' scripts are needed for Next.js bootstrapping and the theme script without nonces;
    // the policy still blocks third-party scripts, plugins, framing, base-tag and form hijacking.
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      `connect-src 'self'${process.env.NODE_ENV === "development" ? " ws:" : ""}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@node-rs/argon2", "bullmq", "ioredis", "@react-pdf/renderer"],
  experimental: {
    serverActions: { bodySizeLimit: "5mb" },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  // Development server only: keep compiled pages in memory instead of evicting them after
  // 25 s of inactivity. Re-compiling an evicted page while a request is in flight can fail
  // ("Unexpected end of JSON input"), which made long browser-test runs flaky.
  onDemandEntries: { maxInactiveAge: 60 * 60 * 1000, pagesBufferLength: 100 },
  webpack(cfg, { dev }) {
    // Development only: don't rebuild when tests, docs or scripts write files (Playwright writes
    // screenshots under e2e/). A rebuild mid-request drops in-flight server actions.
    if (dev) {
      const extra = /[\\/](e2e|tests|docs|scripts|coverage|test-results|playwright-report)[\\/]/;
      const prev = cfg.watchOptions?.ignored;
      const ignored =
        prev instanceof RegExp ? new RegExp(`${prev.source}|${extra.source}`)
        : Array.isArray(prev) ? [...prev, "**/e2e/**", "**/tests/**", "**/docs/**", "**/scripts/**", "**/coverage/**", "**/test-results/**", "**/playwright-report/**"]
        : typeof prev === "string" ? [prev, "**/e2e/**", "**/tests/**", "**/docs/**", "**/scripts/**", "**/coverage/**", "**/test-results/**", "**/playwright-report/**"]
        : extra;
      cfg.watchOptions = { ...cfg.watchOptions, ignored };
    }
    return cfg;
  },
};

export default config;
