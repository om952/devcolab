FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/database/package.json ./packages/database/
RUN pnpm install --frozen-lockfile || pnpm install

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
WORKDIR /app
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/package.json ./apps/web/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=builder /app/packages ./packages

# Run as an unprivileged user.
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs \
  && chown -R nextjs:nodejs /app/apps/web/.next
USER nextjs

WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "start"]
