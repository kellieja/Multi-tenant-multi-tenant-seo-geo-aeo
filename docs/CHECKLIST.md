# Implementation checklist

Legend: ✅ working & tested · 🟡 implemented, needs external credentials to exercise end-to-end · ⬜ not started

## Phase 1 — Foundation
- ✅ Next.js 15 App Router + TypeScript + Tailwind v4 design system (light/dark, tokens, validated chart palette)
- ✅ PostgreSQL schema for all modules + Prisma migrations
- ✅ Email/password auth (argon2id), DB sessions (hashed tokens, sliding expiry, revocation), lockout, rate limiting
- ✅ Organizations, memberships, invitations, roles (Owner/Admin/Manager/Analyst/Client) and permission matrix
- ✅ Tenant isolation enforced in the data-access layer (`tenantDb`) + client-portal website scoping
- ✅ Website management: add/edit/pause/resume/archive/delete, clients/projects/folders/industry/tags, CSV import, team assignments, per-site settings
- ✅ Executive dashboard framework (date ranges, previous-period comparison, site/client filters, CSV export, provenance labels, no fabricated numbers)
- ✅ Settings: workspace branding, members & invites, clients, account/password/sessions, appearance, audit log
- ✅ SSRF-safe outbound HTTP (scheme/port/host checks, DNS pinning, per-hop redirect validation, size/time limits)
- ✅ Encrypted credential storage (AES-256-GCM)
- ✅ Durable job model + BullMQ queue wiring

## Phase 2 — Real data
- ✅ Crawler: robots.txt (RFC 9309 longest-match), XML sitemaps (index + gzip), BFS with depth/page caps, politeness delay + Crawl-delay, include/exclude patterns, redirect-chain capture, outbound link + image checks, SSRF-safe
- ✅ Full, incremental (changed/new/problem URLs + carry-forward) and scheduled (cron per site) crawls
- ✅ 55 issue detectors with evidence, recommendation, implementation, automatable/approval flags
- ✅ Finding lifecycle (open → in progress → resolved / regressed / ignored) with event history; tasks from findings; bulk actions
- ✅ Transparent priority score with per-factor explanation; internal health score with documented formula
- ✅ Audits UI: findings explorer (filters, sort, pagination, CSV), crawl detail with before/after comparison, live job progress, finding detail
- ✅ Technical SEO page (indexability, status codes, depth, response times, structured data, hreflang, CWV)
- ✅ Background worker (BullMQ) with durable job rows, retries/backoff, cancellation, failure notifications, crash recovery, scheduler tick with Redis lock
- 🟡 Google Search Console + GA4: OAuth (signed state, token refresh, revocation), property selection, daily sync, quota/backoff — tested with mocked Google responses; needs GOOGLE_CLIENT_ID/SECRET for live use
- 🟡 PageSpeed Insights: lab + CrUX field data, CWV findings — parser tested; the anonymous quota was exhausted in the build environment, so live runs need an API key
- ✅ Integrations center: status, setup steps, scopes, live credential verification, encrypted storage, sync logs, test/disconnect

## Phase 3 — Automation
- ✅ Workflow engine: schedule (cron, UTC) / event / manual triggers, per-website conditions on live metrics, 12 action types, website/client scope, retries, notify-on, pause/resume, run-now
- ✅ Modes: dry-run (logs only), approval (external actions wait), automatic (internal actions run; live-site changes still need approval unless the site opts into "safe-auto" for human-approved metadata)
- ✅ Event triggers wired: crawl.completed, finding.critical, health.dropped, gsc.synced (backlink/ranking events wired in Phase 4)
- ✅ Visual workflow builder (trigger → conditions → actions blocks, reorder, templates)
- ✅ Approval system enforced server-side at every apply path (bypass attempts tested), expiry, separation of duties for bulk outreach
- ✅ Site changes through WordPress REST with pre-write backup, write verification and rollback (tested against a fake WP server)
- ✅ Execution logs, background job monitor with cancel, tasks (assign, status, client visibility), site-change history
- ✅ Notifications: in-app + Slack webhook + SMTP email for warnings/critical/approvals
- 🟡 AI metadata drafting (Anthropic SDK with server-side refusal fallback; OpenAI/Gemini/Perplexity via REST): needs a provider API key

## Phase 4 — Backlinks
## Phase 5 — AEO & GEO
## Phase 6 — Content, internal linking, competitors, reports, client portal
## Phase 7 — Production readiness
