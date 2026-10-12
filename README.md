# SearchOps

Multi-tenant SEO, AEO (answer engine optimisation) and GEO (generative engine / AI visibility) operations platform for agencies and in-house teams that manage many websites.

It crawls and audits sites, pulls first-party data from Google Search Console, GA4 and PageSpeed Insights, tracks rankings and backlinks through DataForSEO, and measures brand visibility in AI assistants through their official APIs. It also automates the work around all of that. Anything that changes a live website or contacts someone outside the team waits for human approval.

Every number in the product is labelled by where it came from:

| Label | Meaning |
|---|---|
| **Measured** | First-party data from a connected service (Search Console, GA4, PageSpeed, your crawl) |
| **Estimate** | Third-party data (DataForSEO volumes, backlink indexes) |
| **Internal score** | Calculated by SearchOps (health score, AEO readiness, priority), with the formula shown |
| **Sampled** | AI-answer samples. Results vary by user, time and location |

When an integration isn't connected, the product shows a setup screen instead of a number.

## Modules

- **Overview:** Executive dashboard, Websites.
- **Search:** SEO audits, Keywords & rankings, Technical SEO, Internal linking, Competitor intelligence.
- **AI search:** AEO optimisation, GEO & AI visibility.
- **Growth:** Backlink intelligence with an outreach CRM, Content Studio.
- **Operations:**
  - Automation center: workflows, approvals, site changes, job monitor.
  - Reports: white-label PDF/CSV, schedules, client portal.
  - Integrations.
  - Settings: team, clients, branding, audit log.

[docs/CHECKLIST.md](docs/CHECKLIST.md) lists what is implemented and tested, and what needs credentials.

## Architecture

```
Browser ──► Next.js web app (App Router, server actions, API routes)
                │  Prisma (tenant-scoped client)        ▲
                ▼                                      │ job status
            PostgreSQL ◄──────────── Worker (BullMQ processors + 60 s scheduler tick)
                ▲                         │
                └──── Redis (queues, rate limits, locks, worker heartbeat)
```

- **Web** (`pnpm start`): the UI, server actions and API routes. It is stateless and runs anywhere Next.js runs, including Vercel.
- **Worker** (`pnpm worker`): the long-running work.
  - Crawls, syncs, rank checks and AI-visibility runs.
  - Link analysis, report generation and outreach sending.
  - Scheduled workflows.

  It is a long-lived process, so it needs a container or VM rather than a serverless function. You can run more than one; a Redis lock keeps the scheduler tick single.
- **PostgreSQL 16** and **Redis 7**. Redis must use `noeviction`, because evicted keys would mean lost queue jobs.

Tenant isolation is enforced in the data layer. `tenantDb(orgId)` injects and checks `organizationId` on every query against a tenant model. Client-role users are further limited to their client's websites, and they get a 404 on staff-only modules.

## Local development

Requirements: Node 22, pnpm 10, and either Docker (for Postgres and Redis) or local installs of both.

```bash
pnpm install
cp .env.example .env
# Fill ENCRYPTION_KEY and SESSION_SECRET:  openssl rand -base64 32
docker compose up -d db redis
pnpm db:migrate                  # applies prisma/migrations
pnpm dev                         # web on http://localhost:3000
pnpm worker:dev                  # in a second terminal
```

Register at `/register`, create a workspace, add a website and run a crawl.

You can try the crawler without touching a real site. Serve the bundled fixture site, which has deliberate SEO problems, and allow private-network fetches **in development only**:

```bash
echo 'ALLOW_PRIVATE_NETWORK_FETCH="true"' >> .env
pnpm fixture-site 4100           # then add http://127.0.0.1:4100 as a website
```

### JavaScript-rendered sites (React/Vite, many Replit projects)

Each website has a **JavaScript rendering** setting (Website → Settings & team):

| Setting | Behaviour |
|---|---|
| Auto (default) | Each crawl renders the homepage in headless Chromium and compares it with the raw HTML. If content only appears after JavaScript runs, the whole crawl uses rendered pages |
| Always | Every page is rendered |
| Off | Raw HTML only |

Rendered crawls also:

- run AEO assessments and internal-link checks on the rendered pages,
- flag every page whose content needs JavaScript ("Main content only appears after JavaScript runs"), because many AI crawlers and some search engines read only the raw HTML.

Rendering runs in the **worker** and needs Chromium. The Docker image includes it. Elsewhere, run `pnpm exec playwright install --with-deps chromium`, or set `CHROMIUM_PATH`. If Chromium is missing, crawls fall back to raw HTML and the crawl page says so.

Inside the browser, every request the page makes goes through the same SSRF guard as the crawler. WebSockets and service workers are blocked.

### Applying approved changes to live sites

Every live change waits for approval and keeps a backup for rollback. How it reaches the site depends on the connection:

| Site | How changes are applied |
|---|---|
| WordPress | WordPress REST API (titles, meta descriptions, content, internal links) |
| HTML files on a host (cPanel, Hostinger, GoDaddy, a Replit site exported and uploaded) | **File host** integration over SFTP or FTPS. The page's HTML file is edited minimally (title, meta description or internal link), uploaded atomically and checked by reading it back. Plain FTP is refused because it sends the password unencrypted. The SFTP host key is pinned on first connect. |
| Anything else (Replit Deployments, React/Vite apps, custom builds) | **Change packs** (Automation → Change packs): a checklist, JSON and a ready-to-paste Replit Agent prompt. The next crawl verifies each item. |

A built single-page app serves the same `index.html` for every route. A file host therefore can't change per-page titles on it; the app explains this and points to change packs.

### Tests

```bash
pnpm typecheck && pnpm lint
createdb searchops_test          # once; override with TEST_DATABASE_URL
pnpm test                        # unit + integration (needs Postgres and Redis)
# Browser tests need the dev server, the worker and the fixture site running:
E2E_WITH_WORKER=1 pnpm test:e2e  # set PW_CHROMIUM_PATH to use a system Chromium
```

External APIs are exercised against local fakes and recorded responses, never live accounts. That covers Google, DataForSEO, the AI providers, WordPress and SMTP.

## Configuration

All configuration is environment variables; see [.env.example](.env.example). Required:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `APP_URL` | Public URL of the web app (OAuth redirects, links in emails) |
| `ENCRYPTION_KEY` | 32 random bytes, base64. The AES-256-GCM key for stored integration credentials. **If you lose it, stored credentials can't be read. Rotating it means re-connecting integrations.** |
| `SESSION_SECRET` | 32 random bytes, base64. Signs OAuth state |

Optional variables:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: Search Console and GA4 OAuth. Redirect URI: `${APP_URL}/api/integrations/google/callback`.
- `PAGESPEED_API_KEY`.
- `SMTP_URL` and `EMAIL_FROM`: notifications, reports and outreach.
- `CRAWLER_USER_AGENT`.
- `CRAWL_CONCURRENCY` and `WORKER_CONCURRENCY`.
- `CHROMIUM_PATH`: a Chromium binary for JavaScript rendering, if it wasn't installed with Playwright.
- `TRUSTED_PROXY_HOPS`: how many proxies sit in front of the web app. Default `1`. Rate limiting uses it to find the real client IP.

Per-organisation credentials are entered in **Integrations**, verified live and stored encrypted. They are never sent to the browser. That covers DataForSEO, Anthropic, OpenAI, Gemini, Perplexity, WordPress, Slack and SMTP.

`ALLOW_PRIVATE_NETWORK_FETCH` must stay `false` outside local development. The app refuses to start in production with it enabled.

## Deployment

### Option A: web on Vercel, worker on a container host

1. **Data stores.** Provision managed PostgreSQL 16 (e.g. Neon, Supabase, RDS) and Redis 7 with `maxmemory-policy noeviction` (e.g. Upstash with eviction off, ElastiCache, Redis Cloud). Use TLS URLs (`rediss://`).
2. **Vercel.** Import the repository with the Next.js preset and build command `pnpm build`. Set the environment variables above for Production. If your database provider offers a pooled URL, use it for the web app.
3. **Worker.** Deploy the Docker image (below) with the command `worker` and the same environment variables.
   - Any always-on container host works: Railway, Fly.io, Render, ECS or a VM.
   - Give it at least 1 GB of RAM, or 2 GB if it crawls JavaScript-rendered sites (Chromium).
   - Allow a 60 s stop grace period. On `SIGTERM` the worker drains in-flight jobs.
4. **Migrations.** Run `pnpm db:deploy` once per release, before the new web and worker versions take traffic. Use a CI step, or a one-off container: `docker run --env-file .env searchops migrate`.
5. **Monitoring.** Point an uptime monitor at `GET /api/health` (see [docs/OPERATIONS.md](docs/OPERATIONS.md)).

Vercel function limits don't affect long work, because crawls, syncs and report generation all run in the worker. PDF downloads render in a Node.js route.

### Option B: everything in containers

```bash
docker build -t searchops .
docker compose --profile app up -d     # db, redis, migrate (one-off), web, worker
```

The same image serves every role:

| Role | Command |
|---|---|
| Web | `next start` (the default) |
| Worker | `worker` |
| Migrations | `migrate` |

It runs as a non-root user and has a `HEALTHCHECK` against `/api/health`.

For production:

- Replace the compose `db` and `redis` services with managed ones.
- Put the web container behind a TLS-terminating proxy.
- Set `APP_URL` to the public HTTPS URL.

## Security model (summary)

- **Passwords and sessions.** Passwords are hashed with Argon2id. Sessions live in the database, and only a SHA-256 hash of the token is stored. The cookie is httpOnly and SameSite=Lax, with a sliding 30-day expiry. Auth has login lockout and Redis rate limits, keyed on the client IP from the trusted proxy hop.
- **Permissions.** Roles are Owner, Admin, Manager, Analyst and Client. Permissions are checked server-side on every action and route.
  - Client users see only their own client's websites, approved reports covering those websites, and tasks shared with them.
  - Only owners can change or remove another owner.
- **Tenancy.** The database client is tenant-scoped, and cross-tenant writes throw.
- **Outbound requests (SSRF).** Every request to a user-supplied URL goes through an SSRF guard.
  - Private, link-local and metadata IP ranges are blocked after DNS resolution, on every redirect hop.
  - Response size and time are capped.
  - Org-supplied SMTP servers must resolve to public addresses on mail ports.
  - The crawler honours robots.txt and per-site rate limits.
- **Secrets.** Integration secrets are encrypted with AES-256-GCM, and OAuth state is HMAC-signed.
- **Approvals.** Live-site changes, outreach sends and client report delivery need approval, re-checked server-side when the action executes.
  - Approvers see the exact diff and every email in the request. A site-change approval is bound to a hash of the approved content.
  - Site changes keep a backup, can be rolled back, and are refused if the page changed after the proposal.
  - Bulk outreach needs a second person's approval and has a daily cap.
- **Headers.** `next.config.ts` sets a Content-Security-Policy (no third-party scripts, `frame-ancestors 'none'`, `object-src 'none'`), HSTS, nosniff and a referrer policy.
- **Other.** CSV exports are protected against formula injection. Login redirects accept same-origin paths only.
- **Audit log.** Sign-ins, membership, integration, approval, site-change and report events are recorded.

The platform deliberately does **not**:

- scrape search engines or consumer AI chat apps,
- build or buy links, or post comment or forum spam,
- send outreach without approval,
- promise rankings or AI citations.

## Operations

Backups, monitoring, scaling, retention and failure recovery are covered in [docs/OPERATIONS.md](docs/OPERATIONS.md).
