# One image, two processes: the web app (`next start`) and the background worker.
# Build:  docker build -t searchops .
# Web:    docker run --env-file .env -p 3000:3000 searchops
# Worker: docker run --env-file .env searchops worker
# Migrations (run once per deploy, before starting new web/worker containers):
#         docker run --env-file .env searchops migrate

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Build-time placeholders only; real values are injected at runtime.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" ENCRYPTION_KEY="build-only" SESSION_SECRET="build-only-placeholder" \
    pnpm exec prisma generate && pnpm exec next build --no-lint

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 PATH=/app/node_modules/.bin:$PATH
# Runtime commands call the installed binaries directly: corepack/pnpm would need a writable cache as the non-root user.
RUN printf '#!/bin/sh\nexec tsx src/worker/index.ts "$@"\n' > /usr/local/bin/worker \
  && printf '#!/bin/sh\nexec prisma migrate deploy "$@"\n' > /usr/local/bin/migrate \
  && chmod +x /usr/local/bin/worker /usr/local/bin/migrate
RUN groupadd --system app && useradd --system --gid app --home /app app
COPY --from=build --chown=app:app /app /app
# Headless Chromium for JavaScript rendering (used by the worker's crawls of single-page apps).
# The web process never launches it; drop this layer for a smaller web-only image if you like.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
  && chmod -R a+rX /ms-playwright && rm -rf /var/lib/apt/lists/*
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["next", "start"]
