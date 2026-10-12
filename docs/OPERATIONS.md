# Operations guide

How to run SearchOps in production: what to back up, what to monitor, how it scales, and how to recover when something breaks.

## Components and their state

| Component | Holds | Loss impact |
|---|---|---|
| PostgreSQL | Everything durable: tenants, users, sessions, websites, crawls, findings, synced metrics, approvals, site-change backups, reports, audit log, and every Job row (the source of truth for job status) | Critical. Restore from backup |
| Redis | BullMQ queues, rate-limit counters, scheduler lock, worker heartbeat | Recoverable. Queued work is rebuilt from Job rows (see "Redis data loss") |
| `ENCRYPTION_KEY` | The key for stored integration credentials | Critical. Without it, every stored credential must be re-entered |
| Web app | Nothing (stateless) | Redeploy |
| Worker | Nothing (stateless) | Restart; in-flight jobs retry or are marked failed |

## Backups

**PostgreSQL**

- Enable your provider's point-in-time recovery (PITR) with at least 7 days of retention. Neon, Supabase, RDS and Cloud SQL all support it.
- Keep a daily logical backup offsite as well:

  ```bash
  pg_dump --format=custom --no-owner "$DATABASE_URL" > searchops-$(date +%F).dump
  ```

  Keep 30 dailies and 12 monthlies.
- Test a restore every quarter: `pg_restore --clean --no-owner -d "$RESTORE_URL" searchops-YYYY-MM-DD.dump`. Then run `pnpm db:deploy` against the restored database and sign in.

**ENCRYPTION_KEY and SESSION_SECRET**

- Store them in your secrets manager, separately from the database backups, and record where.
- A database backup is only fully usable together with the matching `ENCRYPTION_KEY`.

**Redis**

- Redis doesn't need backups. Turn on AOF persistence (`appendonly yes`) so that a restart keeps pending jobs.

## Monitoring

### Health endpoint

`GET /api/health` is unauthenticated and returns only up/down states:

```json
{ "ok": true, "database": "up", "redis": "up", "worker": "up" }
```

- **HTTP status:** `200` when the database and Redis respond; `503` otherwise. Use it as the load-balancer and uptime check.
- **`worker`:**
  - `up`: a heartbeat was received in the last 2 minutes.
  - `stale`: the last heartbeat is older than 2 minutes.
  - `down`: no heartbeat.

  Alert if it isn't `up` for 5 minutes. The web app keeps serving without the worker, but crawls, syncs, schedules, reports and outreach stop.

### Alerts to set up

| Signal | Where | Threshold |
|---|---|---|
| Health check failing | uptime monitor on `/api/health` | 2 consecutive failures |
| Worker heartbeat | `worker` field of `/api/health` | not `up` for 5 min |
| Failed jobs | Automation → Jobs, or `SELECT type, count(*) FROM "Job" WHERE status='FAILED' AND "finishedAt" > now() - interval '1 hour' GROUP BY 1` | sudden increase |
| Queue backlog | `SELECT count(*) FROM "Job" WHERE status='QUEUED' AND "queuedAt" < now() - interval '30 minutes'` | > 0 sustained |
| Integration errors | Integrations page shows status and sync logs per connection; `SELECT provider, count(*) FROM "IntegrationConnection" WHERE status='ERROR' GROUP BY 1` | any |
| Database | provider metrics | CPU > 80%, storage > 80%, connections near limit |
| Redis memory | provider metrics | > 75% (queues fail with `noeviction` when full) |

### Logs

- **Web:** platform logs (Vercel or the container runtime). Server-action failures are logged with an `[action-error]` prefix. Tenant-isolation violations are logged with a `[tenant-violation]` prefix and should never happen; treat one as a security incident.
- **Worker:** stdout. Prefixes are `[worker]`, `[scheduler]` and `[worker:<queue>]` for job failures.
- **Product audit trail:** Settings → Audit log, or the `AuditLog` table. It records sign-ins, membership and role changes, integration changes, approvals, site changes and rollbacks, and report approvals and sends.

Failed jobs also notify the organisation in-app. Slack and email delivery are used too, when the organisation has configured them.

## Scaling

- **Web:** scale horizontally; it is stateless. On Vercel this is automatic. Use a pooled database URL (PgBouncer or the provider's pooler) to keep connection counts bounded.
- **Worker:** run more replicas for more throughput. Each replica processes `CRAWL_CONCURRENCY` crawls (default 2) and `WORKER_CONCURRENCY` other jobs (default 5). The scheduler tick runs on only one replica at a time (Redis lock).
  - Crawls are network-bound and polite: each respects the site's crawl delay and robots.txt.
  - Raising concurrency increases outbound traffic and provider API spend, but doesn't make any one site crawl faster.
- **JavaScript rendering:** a rendered crawl uses one headless Chromium per running crawl, about 300–500 MB of RAM, and is roughly 5–10× slower per page than a raw crawl. Size worker memory and `CRAWL_CONCURRENCY` accordingly. "Auto" mode only renders sites that need it.
- **Provider quotas:** Google APIs back off on 429 and quota errors. DataForSEO and AI provider costs are recorded per sync in the sync logs, so watch them after onboarding large clients.

## Data retention

The worker's maintenance task deletes old operational data daily:

| Data | Kept for |
|---|---|
| Finished Job rows | 90 days |
| Integration sync logs | 90 days |
| Read notifications | 90 days |
| Workflow execution logs | 180 days |
| PageSpeed results | 365 days |
| Audit log | 365 days |
| Search Console query rows | 490 days (Google keeps 16 months) |

The values live in `RETENTION_DAYS` in `src/server/maintenance.ts`. Crawls, findings, reports, site-change backups and backlinks are kept until the website or organisation is deleted.

## Deploying a new version

1. Run `pnpm typecheck && pnpm lint && pnpm test` in CI.
2. Run migrations: `pnpm db:deploy`, or `docker run … searchops migrate`. Migrations are additive within a release, so the old version keeps working while it runs.
3. Deploy the web app.
4. Restart the worker(s). On `SIGTERM` the worker stops taking jobs and waits for in-flight ones; give it a 60 s grace period. Jobs still running when it exits are retried by BullMQ's stalled-job handling, or marked failed and can be re-run.

To roll back, redeploy the previous image or commit. If the release included a migration that the old code can't handle, restore the database to the pre-deploy PITR timestamp. Avoid this by keeping migrations backward compatible.

## Failure recovery

### Worker crashed or was killed

- Restart it.
- On startup, the worker marks rows stuck in `RUNNING` for over 6 hours as failed.
- BullMQ re-delivers jobs whose lock expired (2-minute lock).
- The scheduler tick then repairs remaining drift (see the next section).
- A crawl that was interrupted is marked failed. Start it again from SEO Audits; findings from the previous successful crawl are unaffected.

### Redis data loss or restore

Job rows in PostgreSQL are authoritative. Within about 10 minutes of the worker coming back, the `recover-orphaned-jobs` scheduler task:

- re-queues `QUEUED` rows that have no queue entry,
- marks `RUNNING` rows whose queue entry vanished as failed, so they no longer block new runs.

Recurring schedules continue automatically because the scheduler recomputes due work from the database. Rate-limit counters reset, which is harmless.

### Database restore

- Restore to a new instance from PITR or a dump, and point `DATABASE_URL` at it.
- Keep the same `ENCRYPTION_KEY`.
- Run `pnpm db:deploy`, then restart the web app and workers.
- Users may need to sign in again if their sessions post-date the restore point.

### Lost or leaked ENCRYPTION_KEY

1. Generate a new key and deploy it.
2. Every stored integration secret is now unreadable. The Integrations page shows those connections in error. Reconnect each one: Google OAuth, API keys, WordPress application passwords, SMTP.
3. If the old key may have leaked, also rotate the upstream credentials. Revoke the Google tokens, regenerate the API keys and WordPress application passwords.

### Leaked SESSION_SECRET

Rotate it and deploy. This only affects OAuth state signing: in-progress Google connections must be restarted. To end all user sessions as well, run `DELETE FROM "Session";`.

### A bad change reached a live site

1. Open Automation → Site changes and roll the change back. The pre-change value was saved when it was applied.
2. If the page was edited by hand after the change, compare it manually before rolling back; rollback restores the saved value.
3. Pause the workflow that proposed it (Automation → Workflows), and review its mode and the site's auto-apply policy.

### Outreach sent in error

Only approved batches are sent, and sending stops at the daily cap. Reject any pending send approvals, and cancel queued "Outreach email send" jobs in Automation → Jobs. The outreach pipeline shows every sent message with its recipient and the approval it belonged to.

### Integration keeps failing

Open Integrations, then the connection's sync log. Common causes:

- an expired or revoked Google token: reconnect;
- a lost Search Console property permission: re-select the property;
- exhausted provider credits;
- a WordPress application password that was revoked.

The **Test** button re-verifies credentials live.

## Security operations

- Rotate provider API keys and WordPress application passwords at least yearly, and whenever a team member with access leaves.
- Review Settings → Members and the audit log monthly. Client users should only be linked to their own client.
- Keep `ALLOW_PRIVATE_NETWORK_FETCH=false` in every non-local environment. The app refuses to start in production with it enabled.
- Set `TRUSTED_PROXY_HOPS` to the number of reverse proxies in front of the web app, so rate limits key on the real client IP. On Vercel the platform header is used automatically.
- Keep dependencies current: `pnpm outdated`, and `pnpm audit` in CI.
