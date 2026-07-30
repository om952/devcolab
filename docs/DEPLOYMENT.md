# Deployment runbook

Ordered checklist for taking DevColab from a clean checkout to live in
production. Background and rationale for each piece lives in the main
[README](../README.md#deploying-to-production) — this is the sequence to
actually follow, plus the failure modes to expect.

## 0. Decide your database path

Two options — pick one before starting, it changes step 3 and step 6:

- **Bundled Postgres container** — simplest, but you own backups.
- **Neon** (or another managed Postgres) — no backup burden, has a free
  tier. See the README's [Using Neon](../README.md#using-neon-instead-of-the-bundled-postgres)
  section for the account setup.

## 1. Point DNS at the host

Caddy issues TLS certificates automatically on first boot, but only if both
records already resolve — do this first since propagation can take time:

```
devcolab.example.com      A  <host ip>
api.devcolab.example.com  A  <host ip>
```

## 2. Generate secrets

```bash
cp .env.example .env
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # INTERNAL_API_KEY
openssl rand -hex 16   # POSTGRES_PASSWORD (bundled Postgres path only)
```

Fill in `.env`:
- `JWT_SECRET`, `INTERNAL_API_KEY` — the values just generated
- `CORS_ORIGIN` — `https://devcolab.example.com` (no `localhost`)
- `DEVCOLAB_DOMAIN` / `DEVCOLAB_API_DOMAIN` — the domains from step 1
- `NEXT_PUBLIC_COLLAB_SERVER_URL` — `https://api.devcolab.example.com`
- Database path chosen in step 0:
  - Bundled: `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`
  - Neon: `DATABASE_URL` (pooled) and `DIRECT_URL` (unpooled) from the Neon
    dashboard

## 3. Run preflight

```bash
./scripts/preflight.sh
```

Checks secret strength (rejects known-weak `JWT_SECRET`/`POSTGRES_PASSWORD`
defaults), that `CORS_ORIGIN` isn't `localhost`, that both domains resolve,
and that the database is reachable. Fix everything it flags before
continuing — this is deliberately the same class of checks `env.ts` enforces
at boot, just runnable ahead of time instead of failing mid-deploy.

If DNS hasn't propagated yet but you want to verify everything else:
`./scripts/preflight.sh --skip-dns`.

## 4. Apply migrations

```bash
# Bundled Postgres — from the host, after starting just the db:
docker compose up -d postgres
export DATABASE_URL=postgresql://devcolab:<password>@localhost:5433/devcolab
pnpm db:migrate

# Neon — from anywhere, using the connection strings from step 2:
export DATABASE_URL=<pooled Neon URL>
export DIRECT_URL=<unpooled Neon URL>
pnpm db:migrate
```

## 5. Start the stack

```bash
# Bundled Postgres:
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# Neon:
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  -f docker-compose.neon.yml up -d --build
```

## 6. Verify

```bash
curl -s https://devcolab.example.com/api/health
curl -s https://api.devcolab.example.com/health/ready
docker compose logs caddy --tail 50   # confirm certs issued, no TLS errors
```

`/health/ready` returning `503` almost always means the database isn't
reachable from inside the container — recheck `DATABASE_URL` and, for the
bundled path, that `postgres` is healthy (`docker compose ps`).

## Redeploying

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  [-f docker-compose.neon.yml] up -d --build
```

Both app services drain on `SIGTERM` (connected clients get a
`server:shutdown` event to reconnect elsewhere) with a 15s cap, so this is a
zero-downtime restart, not a hard cutover. New Prisma migrations, if any,
need `pnpm db:migrate` run again before this step — the app does not run
migrations on boot.

## Rollback

Prisma migrations here are forward-only — there's no automatic `down`.
Rolling back means:

1. Redeploy the previous image/commit (`git checkout <previous-sha>` then
   repeat the "Redeploying" steps above).
2. Only hand-write a reverse migration if the failed migration actually
   broke data compatibility with the old code — most bad deploys are a code
   bug, not a schema problem, and don't need one.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Caddy never gets a cert | DNS records not resolving yet — recheck with `dig devcolab.example.com` |
| `preflight.sh` fails on `POSTGRES_PASSWORD` | Still set to the `.env.example` default (`devcolab`) — generate a real one |
| `/health/ready` is `503` after deploy | Database unreachable — check `DATABASE_URL`, and for Neon, that the free tier isn't still waking from idle |
| Web app calls `localhost:4000` in prod | `NEXT_PUBLIC_*` vars are baked in at **build** time — `docker compose build web` after changing them, restart alone won't pick them up |
