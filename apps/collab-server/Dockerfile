FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/collab-server/package.json ./apps/collab-server/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/database/package.json ./packages/database/
RUN pnpm install --frozen-lockfile || pnpm install

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/collab-server/node_modules ./apps/collab-server/node_modules
COPY --from=deps /app/packages/shared-types/node_modules ./packages/shared-types/node_modules
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules
COPY . .
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
WORKDIR /app/apps/collab-server
EXPOSE 4000
CMD ["node", "dist/index.js"]
