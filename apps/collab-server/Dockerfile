FROM node:20-alpine AS base
# Prisma's query engine links against OpenSSL, which the bare node:20-alpine
# image does not ship. Without it the engine cannot load and every query fails.
RUN apk add --no-cache openssl \
  && corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/collab-server/package.json ./apps/collab-server/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/database/package.json ./packages/database/
# No `|| pnpm install` fallback: a stale lockfile must fail the build,
# not silently resolve fresh versions — which is the whole point of the flag.
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/collab-server/node_modules ./apps/collab-server/node_modules
COPY --from=deps /app/packages/shared-types/node_modules ./packages/shared-types/node_modules
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules
COPY . .

# Generate the Prisma client before compiling. The deps stage installs from
# package.json alone, where prisma/schema.prisma is not yet present, so the
# postinstall generate produces nothing usable. This was previously masked by
# COPY . . pulling in the host's already-generated client along with its
# node_modules — with a .dockerignore in place, tsc fails on missing Prisma
# types instead.
RUN pnpm exec prisma generate

RUN pnpm --filter @devcolab/shared-types build
RUN pnpm --filter @devcolab/database build
RUN pnpm --filter @devcolab/collab-server build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/apps/collab-server/dist ./apps/collab-server/dist
COPY --from=builder /app/apps/collab-server/package.json ./apps/collab-server/
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/collab-server/node_modules ./apps/collab-server/node_modules
COPY --from=builder /app/packages/shared-types/node_modules ./packages/shared-types/node_modules
COPY --from=builder /app/packages/database/node_modules ./packages/database/node_modules

# Run as an unprivileged user.
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs collab
USER collab

WORKDIR /app/apps/collab-server
EXPOSE 4000
CMD ["node", "dist/index.js"]
