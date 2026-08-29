FROM node:26-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/database/package.json ./packages/database/
# No `|| pnpm install` fallback: a stale lockfile must fail the build,
# not silently resolve fresh versions — which is the whole point of the flag.
RUN pnpm install --frozen-lockfile

FROM base AS builder
# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so they
# must be present here. Setting them only at container runtime has no effect.
ARG NEXT_PUBLIC_COLLAB_SERVER_URL=http://localhost:4000
ARG NEXT_PUBLIC_AI_SERVICE_URL=http://localhost:8000
ENV NEXT_PUBLIC_COLLAB_SERVER_URL=$NEXT_PUBLIC_COLLAB_SERVER_URL
ENV NEXT_PUBLIC_AI_SERVICE_URL=$NEXT_PUBLIC_AI_SERVICE_URL
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/shared-types/node_modules ./packages/shared-types/node_modules
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules
COPY . .
RUN pnpm --filter @devcolab/shared-types build
RUN pnpm --filter @devcolab/database build
RUN pnpm --filter @devcolab/web build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs

# `output: "standalone"` traces the modules actually imported and emits a
# self-contained server, so the whole workspace node_modules no longer has to
# ship. Static assets are not traced and must be copied alongside it.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
