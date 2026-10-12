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

## Phase 4 — Backlinks, keywords & competitors
- ✅ Backlink inventory: CSV import (common export column names), manual add, status lifecycle, referring-domain rollups, anchor/rel distribution, weekly link velocity, CSV export
- ✅ Live link verification job: robots-aware, per-host politeness, anchor/rel capture, lost/broken/redirected detection, notifications + backlink.lost/new events
- 🟡 DataForSEO backlink + referring-domain sync with cost logging (tested with mocked API responses)
- ✅ Opportunity pipeline (Discovered → … → Verified/Lost) with prospect research: relevance scoring + explanation, broken outbound links, public contact discovery, dedupe
- 🟡 Discovery: competitor link gap, unlinked brand mentions (DataForSEO)
- ✅ Outreach CRM: templates with variables, campaigns, drafts, approval by a second person, daily send cap, SMTP sending, follow-up reminders, reply logging, acquired-link verification → tracked backlink
- ✅ Disavow preparation with mandatory human review before export
- ✅ Keywords: bulk/CSV add, groups/tags/target URL mapping, rule-based intent (labelled), history, mismatch flags, CSV export
- 🟡 Rank tracking + volume/intent/ideas via DataForSEO (no search-engine scraping); drop alerts + ranking.dropped event
- ✅ Search Console insights: top queries, striking distance, declines, cannibalization, one-click tracking
- 🟡 Competitors: CRUD, provider suggestions, cached keyword-gap analysis

## Phase 5 — AEO & GEO
- ✅ AEO readiness assessment per page (question headings, concise answers, lists/tables, author/date, schema validity, readability), key-page selection by GSC clicks else internal links, worker job
- ✅ Question opportunities from GSC question queries and informational keywords, with a suggested answer format and status workflow
- 🟡 People Also Ask questions via DataForSEO (needs credentials)
- ✅ JSON-LD validator for supported rich-result types (required + recommended properties)
- 🟡 AI answer drafts (fact guardrails, stored as reviewable suggestions): needs an AI provider key
- 🟡 GEO prompt sets (market, language, platforms, competitor terms, cron schedule) run via official APIs (Claude web search, OpenAI web search, Gemini grounding, Perplexity Sonar) with neutral prompts; every answer is stored with model, date, response, citations and methodology. Needs provider keys; tested with mocked providers
- ✅ GEO analysis: mention/citation rate, share of voice, sentiment (labelled heuristic), cited domains, own pages cited, unanswered prompts, weekly trend; all labelled "sampled"
- ✅ Entity & authority audit from crawl data (Organization markup, name consistency, sameAs, logo/contact)
- ✅ Signup/login show non-field errors (e.g. rate limiting) inline
## Phase 6 — Content, internal linking, reports, client portal
- ✅ Content Studio analysis of a live URL (robots-aware, SSRF-guarded) or pasted draft: structure, headings outline, readability estimate, keyword placement and frequency, top terms, near-duplicate check against crawled pages
- ✅ Competitor page comparison: uncovered subtopics, term gaps, structured-data gap, readability and length, with an honest summary
- 🟡 AI content briefs grounded in DataForSEO SERP (when connected), Search Console queries and crawled pages; internal-link URLs limited to real pages; claims to verify. Needs an AI provider key
- ✅ Suggestion review queue: edit, approve, reject, reopen; numbers/superlatives flagged for verification; approved title/meta proposed to WordPress through site-change approval
- ✅ AI title/meta drafting runs as a background job (needs an AI provider key)
- ✅ Internal linking: target phrases from tracked keywords, GSC queries, H1 and title; candidates from crawl text confirmed on the live page; per-source/target caps; rejected links aren't re-suggested; applied links detected by the next crawl
- ✅ Link graph: orphan pages, click depth, inlink distribution, weakest pages
- ✅ Safe link insertion (never inside links, headings, code; paragraphs and list items only) applied to WordPress with approval, backup, write verification and rollback
- ✅ Full-content site changes are refused if the page changed after the proposal
- ✅ Reports: frozen snapshot of measured/estimate/internal/sampled numbers, per-site health, issues, top queries, keyword movement, client-visible completed work
- ✅ White-label PDF (brand name, colour, logo fetched through the SSRF guard) and CSV per report; dashboard PDF export
- ✅ Approval before clients can see a report; edit commentary until approval; emailing is refused server-side for unapproved reports
- 🟡 Weekly/monthly schedules generated by the worker, approval notifications, emailed on approval (or auto-approve, which only approvers can enable). Email needs SMTP
- ✅ Client portal: client users see approved reports covering only their websites and the tasks shared with them; staff-only modules hidden
- ✅ Website hub: per-site summary of every module with provenance labels
## Phase 7 — Production readiness
- ✅ Security review of all actions, routes and job processors; fixes verified by tests:
  - client users get a 404 on staff modules and see only notifications addressed to them; approval history scoped to their websites
  - approvers see the exact diff of a site change and every email in an outreach batch; approvals are bound to a hash of the approved content
  - "safe-auto" publishing only trusts content approved by someone who can decide site changes
  - org-supplied SMTP servers must be public hosts on mail ports (SSRF)
  - same-origin-only login redirects; CSV formula guard tightened; rate limits use the trusted proxy hop for client IP
  - only owners can demote or remove owners; resuming an auto-approve report schedule needs approver rights; approve screen lists actual recipients
  - Content-Security-Policy added (no third-party scripts, no framing, no plugins)
- ✅ `/api/health` (database, Redis, worker heartbeat) for load balancers and uptime monitors
- ✅ Orphaned-job recovery: QUEUED rows with no queue entry are re-queued; RUNNING rows whose queue entry vanished are failed
- ✅ Production `next build` passes
- ✅ Dockerfile (non-root, healthcheck; `next start` / `worker` / `migrate`) and docker-compose; the full image build (including the OpenSSL and Chromium layers) is verified in CI on every push
- ✅ README: architecture, local setup, configuration, deployment (Vercel web + container worker, or all containers), security model
- ✅ docs/OPERATIONS.md: backups, monitoring/alerts, scaling, retention, deploys and rollback, failure recovery runbooks

## Phase 8 — Replit and non-WordPress sites
- ✅ GitHub Actions CI: typecheck, lint, unit/integration tests (Postgres + Redis services), production build, Playwright browser tests against a live stack, Docker image build
- ✅ JavaScript rendering for client-rendered sites (React/Vite, typical Replit projects): auto-detect from the homepage, rendered crawl with raw-vs-rendered comparison, "Main content only appears after JavaScript runs" finding, AEO and internal-link jobs use rendered pages; every browser request goes through the SSRF guard, WebSockets and service workers blocked; falls back to raw HTML when Chromium is unavailable
- ✅ Change packs for sites without a CMS connector: approved titles, meta descriptions, answer sections, internal links (and optionally top open issues) as a Markdown checklist, JSON and a ready-to-paste Replit Agent prompt (adds pre-rendering guidance on JavaScript sites); every crawl verifies which items are live, marks sources applied and closes finished packs
- ✅ File host connector (SFTP / FTPS) for HTML sites on shared hosting, including Replit sites exported and uploaded: minimal title / meta description / internal-link edits, approval with exact diff, atomic upload with read-back verification, stale-file refusal, rollback; plain FTP refused; host must be public; SFTP host key pinned on first connect and changes detected; explains single-page apps and points to change packs. Tested end to end against an in-memory SFTP server; FTPS uses the same pipeline (TLS required, certificates verified) but has no automated server test
- ✅ GitHub connector for sites built from a repository (Replit projects synced to GitHub): locates the page's current title, meta description or paragraph in the source (code search, falling back to a bounded repository scan; build output and dependencies ignored), escapes the edit for HTML / JS string / JSX / Markdown, approval opens a pull request, merges and closes are tracked, rollback opens a revert PR; refuses dynamic or ambiguous text and points to change packs; token must have write access. Tested end to end against a fake GitHub API

