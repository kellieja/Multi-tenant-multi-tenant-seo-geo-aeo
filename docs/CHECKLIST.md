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
- ⬜ Crawler & audit engine
- ⬜ Google Search Console / GA4 / PageSpeed integrations

## Phase 3 — Automation
- ⬜ Worker, scheduler, workflows, approvals, notifications

## Phase 4 — Backlinks
## Phase 5 — AEO & GEO
## Phase 6 — Content, internal linking, competitors, reports, client portal
## Phase 7 — Production readiness
