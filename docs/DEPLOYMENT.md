# Deployment runbook

Ordered checklist for taking DevColab from a clean checkout to live in
production. Background and rationale for each piece lives in the main
[README](../README.md#deploying-to-production) — this is the sequence to
actually follow, plus the failure modes to expect.

## Free hosting on Render

`render.yaml` deploys all three services on Render's free tier with no server
or domain of your own. Use this instead of steps 1-6 below; the sections after
it describe the self-hosted VM path.

1. **Neon**: create a project in AWS Singapore, database `devcolab`. Copy the
   pooled connection string (`-pooler` in the host) as `DATABASE_URL` and the
   unpooled one as `DIRECT_URL`.
2. **Migrations**, from your machine (Neon only, once and after any new
   migration):
   ```bash
   export DATABASE_URL='<pooled url>'
   export DIRECT_URL='<unpooled url>'
   pnpm db:migrate
   ```
3. **LLM keys**: none on the server. Each user adds their own Gemini or Groq
   key in the app (the "Add AI key" button in a session).
4. **Render**: New -> Blueprint -> connect the repo, branch `master`. Render
   asks for `DATABASE_URL` (pooled Neon URL); everything else is generated or
   set in the file.
5. **Verify** once all three are live (the first request to a sleeping service
   takes about a minute):
   ```bash
   curl -s https://devcolab-api.onrender.com/health/ready
   curl -s https://devcolab-web.onrender.com/api/health
   ```

The browser only talks to `devcolab-web`, which proxies `/api` and
`/socket.io` to `devcolab-api`. That keeps the httpOnly session cookie
first-party; it is also why the API's `TRUST_PROXY` is 2.

When a release adds a migration, run step 2 against Neon **before** merging:
Render deploys on merge, and the new code expects the new schema.

Limits to expect: services sleep after 15 minutes idle, and the 750 free
instance hours are shared across all three. Changing
`NEXT_PUBLIC_COLLAB_SERVER_URL` needs a redeploy of `devcolab-web`, since it is
baked in at build time.

### Monitoring, backups and rollback (Render)

**Error tracking (Sentry, free).** Create one Sentry project per service
(Next.js for the web app, Node for the API, Python/FastAPI for the AI service)
and set their DSNs in the Render dashboard:

| Service | Variable | Note |
|---|---|---|
| devcolab-web | `NEXT_PUBLIC_SENTRY_DSN` | Build-time: redeploy the service after setting it |
| devcolab-api | `SENTRY_DSN` | |
| devcolab-ai | `SENTRY_DSN` | |

Unset means reporting is off. Events never include cookies, auth headers or a
user's LLM key.

**Uptime.** `.github/workflows/health-check.yml` checks all three services
and the web-to-API proxy every 6 hours. A failed run emails you. Do not
point an external monitor at the site every few minutes: each check wakes the
free services, and staying awake burns through the 750 free hours a month.
GitHub pauses scheduled workflows in a repository with no commits for 60
days; re-enable it under Actions if that happens.

**Backups.** `.github/workflows/backup.yml` dumps Neon weekly, encrypts the
dump and keeps it for 90 days as a workflow artifact. Add two repository
secrets under Settings -> Secrets and variables -> Actions:

- `NEON_DIRECT_URL`: Neon's **direct** (unpooled) connection string
- `BACKUP_PASSPHRASE`: at least 20 random characters (`openssl rand -base64 32`).
  **Store a copy in your password manager.** Without it no backup can be
  restored, and GitHub will not show it to you again.

Run it once by hand (Actions -> Database backup -> Run workflow) to confirm it
works.

To restore: download the artifact from the run, then

```bash
unzip devcolab-db-*.zip
gpg --batch --passphrase '<BACKUP_PASSPHRASE>' --decrypt devcolab-*.dump.gpg > devcolab.dump
# Into a NEW Neon branch or database first, never straight over production:
docker run --rm -v "$PWD":/w postgres:18-alpine \
  pg_restore --no-owner --no-privileges -d '<target direct URL>' /w/devcolab.dump
```

For a mistake caught within 6 hours, Neon's own restore (Branches -> Restore)
is faster.

**Rolling back a bad deploy.** In Render, open the broken service -> Events,
find the last good deploy and choose **Rollback**. Then revert the PR on
GitHub, because the next merge to `master` deploys again. Migrations are
not undone by a rollback, which is why they must stay additive (new columns
with defaults, no drops or renames in the same release as the code that
stops using them).

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

Production runs the images CI built, scanned and pushed to GHCR — it does not
compile anything. Pick the commit you are deploying and pin it:

```bash
export DEVCOLAB_IMAGE_TAG=<commit sha>   # must be a SHA, never `latest`
```

Confirm CI actually published that SHA before continuing (Actions -> the run
for that commit -> the "Docker build, scan and publish" job summary).

```bash
# Bundled Postgres:
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Neon:
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  -f docker-compose.neon.yml up -d
```

If the images are private, authenticate the host once:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github username> --password-stdin
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
export DEVCOLAB_IMAGE_TAG=<new commit sha>
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  [-f docker-compose.neon.yml] up -d
```

Both app services drain on `SIGTERM` (connected clients get a
`server:shutdown` event to reconnect elsewhere) with a 15s cap, so this is a
zero-downtime restart, not a hard cutover. New Prisma migrations, if any,
need `pnpm db:migrate` run again before this step — the app does not run
migrations on boot.

## Rollback

Rolling back is changing the tag back to the previous SHA — no rebuild, no
checkout, and the image you land on is one CI already tested and scanned:

```bash
export DEVCOLAB_IMAGE_TAG=<previous known-good sha>
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  [-f docker-compose.neon.yml] up -d
```

Keep the last known-good SHA written down somewhere before you deploy, so you
are not searching for it during an incident.

Prisma migrations are forward-only, so the schema does not roll back with the
code. Only hand-write a reverse migration if the failed migration actually
broke compatibility with the old code — most bad deploys are a code bug, not a
schema problem, and don't need one.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Caddy never gets a cert | DNS records not resolving yet — recheck with `dig devcolab.example.com` |
| `preflight.sh` fails on `POSTGRES_PASSWORD` | Still set to the `.env.example` default (`devcolab`) — generate a real one |
| `/health/ready` is `503` after deploy | Database unreachable — check `DATABASE_URL`, and for Neon, that the free tier isn't still waking from idle |
| Web app calls `localhost:4000` in prod | `NEXT_PUBLIC_*` vars are baked in at **build** time, and images are now built by CI — set them as repository *variables* (`NEXT_PUBLIC_COLLAB_SERVER_URL`, `NEXT_PUBLIC_AI_SERVICE_URL`) under Settings -> Secrets and variables -> Actions, then re-run CI to publish a corrected image |
| `manifest unknown` when starting | The SHA has no published image — check CI succeeded for that commit, and that you are on a SHA from `master` |
| Compose errors on `DEVCOLAB_IMAGE_TAG` | Deliberate: the overlay refuses to start without a pinned tag |
