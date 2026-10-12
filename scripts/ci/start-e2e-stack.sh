#!/usr/bin/env bash
# Starts everything the browser tests need, in the background, and waits until it is ready:
# the fixture website (127.0.0.1:4100), the Next.js dev server (:3000) and the worker.
# Used by CI; also works locally once Postgres and Redis are running and migrations are applied.
# Logs go to $E2E_LOG_DIR. It must be OUTSIDE the project: the dev server watches the project
# tree, and writing its own log there makes it recompile (and drop requests) on every line.
set -euo pipefail
LOG_DIR="${E2E_LOG_DIR:-${RUNNER_TEMP:-/tmp}/searchops-e2e-logs}"
mkdir -p "$LOG_DIR"

wait_for() { # url, name, seconds
  for _ in $(seq 1 "$3"); do
    if curl -fs -o /dev/null "$1"; then echo "$2 is up"; return 0; fi
    sleep 1
  done
  echo "$2 did not start in $3 s; last log lines:" >&2
  tail -n 50 "$LOG_DIR"/*.log >&2 || true
  return 1
}

pnpm exec tsx scripts/fixture-site.ts 4100 > "$LOG_DIR/fixture.log" 2>&1 &
pnpm exec next dev -p 3000 > "$LOG_DIR/web.log" 2>&1 &
pnpm exec tsx src/worker/index.ts > "$LOG_DIR/worker.log" 2>&1 &

wait_for http://127.0.0.1:4100/ "fixture site" 30
wait_for http://localhost:3000/login "web app" 180

# The dev server compiles each route on first request; warm the ones the specs visit so
# compile time doesn't count against test timeouts.
for path in /register /login /onboarding /dashboard /websites /audits /technical /keywords /backlinks \
  /competitors /aeo /geo /content /internal-links /reports /automation /automation/workflows/new \
  /integrations /settings /audits/findings/warmup /api/health; do
  curl -s -o /dev/null --max-time 180 "http://localhost:3000$path" || true
done

for _ in $(seq 1 60); do
  if curl -fs http://localhost:3000/api/health | grep -q '"worker":"up"'; then echo "worker is up"; exit 0; fi
  sleep 1
done
echo "worker heartbeat not seen; worker log:" >&2
tail -n 50 "$LOG_DIR/worker.log" >&2
exit 1
