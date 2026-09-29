FROM node:22-alpine AS base
# Prisma's query engine links against OpenSSL, which the bare node:22-alpine
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

# Production-only dependencies for the runtime image. The stage above installs
# devDependencies too (vitest, esbuild, ts-node, ...); the server never loads
# them and they carry their own CVEs, so none of them ship. (`pnpm prune --prod`
# is not enough: it unlinks them but leaves their files in node_modules/.pnpm.)
#
# prisma is a regular dependency of @devcolab/database so the CLI is present
# to generate the client here. It resolves @prisma/client starting from the
# schema's directory, and at the repo root that is only a skipped devDependency,
# so generate from a copy of the schema that lives inside the package.
FROM base AS prod-deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/collab-server/package.json ./apps/collab-server/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/database/package.json ./packages/database/
COPY prisma/schema.prisma ./packages/database/schema.prisma
RUN pnpm install --frozen-lockfile --prod
WORKDIR /app/packages/database
RUN pnpm exec prisma generate --schema=./schema.prisma
WORKDIR /app

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

# Fresh image rather than `base`: pnpm/corepack are build tools, and npm is not
# needed to run `node`. npm bundles its own copy of tar, which the scanner
# flags as CRITICAL, so it is removed rather than shipped unused.
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/apps/collab-server/dist ./apps/collab-server/dist
COPY --from=builder /app/apps/collab-server/package.json ./apps/collab-server/
COPY --from=builder /app/packages/shared-types/package.json ./packages/shared-types/
COPY --from=builder /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder /app/packages/database/package.json ./packages/database/
COPY --from=builder /app/packages/database/dist ./packages/database/dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/collab-server/node_modules ./apps/collab-server/node_modules
COPY --from=prod-deps /app/packages/database/node_modules ./packages/database/node_modules

# Run as an unprivileged user.
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs collab
USER collab

WORKDIR /app/apps/collab-server
EXPOSE 4000
CMD ["node", "dist/index.js"]
