# DevColab

AI-powered real-time code review platform with collaborative WebSocket sessions and a LangGraph multi-agent analysis pipeline.

## Architecture

```
devcolab/
├── apps/
│   ├── web/             Next.js 14 frontend (port 3000)
│   ├── collab-server/   Express + Socket.IO (port 4000)
│   └── ai-service/      FastAPI + LangGraph (port 8000)
├── packages/
│   └── shared-types/    Shared TypeScript interfaces
└── docker-compose.yml   PostgreSQL + all services
```

## Prerequisites (macOS — Apple Silicon / M4)

Install the following before getting started:

### 1. Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. Node.js 20+

```bash
brew install node
node --version   # should be >= 18
```

### 3. pnpm

```bash
corepack enable
corepack prepare pnpm@9 --activate
pnpm --version
```

### 4. Python 3.12+

```bash
brew install python@3.12
python3 --version
```

### 5. Docker Desktop (for PostgreSQL)

Download and install [Docker Desktop for Mac (Apple Silicon)](https://www.docker.com/products/docker-desktop/).

Verify:

```bash
docker --version
docker compose version
```

---

## Setup

Clone the repo and install dependencies from the monorepo root:

```bash
cd devcolab
pnpm install
pnpm build:types
```

### Python virtual environment (ai-service)

```bash
cd apps/ai-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ../..
```

---

## Running locally

Open **four separate terminal tabs** (or use a process manager like `tmux`).

### Terminal 1 — PostgreSQL

```bash
cd devcolab
docker compose up postgres
```

### Terminal 2 — Web (Next.js)

```bash
cd devcolab
pnpm dev:web
```

Health check: [http://localhost:3000/api/health](http://localhost:3000/api/health)

### Terminal 3 — Collab Server (Express + Socket.IO)

```bash
cd devcolab
pnpm dev:collab
```

Health check: [http://localhost:4000/health](http://localhost:4000/health)

### Terminal 4 — AI Service (FastAPI)

```bash
cd devcolab/apps/ai-service
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

Health check: [http://localhost:8000/health](http://localhost:8000/health)

---

## Verify all services

Once everything is running:

```bash
curl http://localhost:3000/api/health   # {"status":"ok","service":"web"}
curl http://localhost:4000/health       # {"status":"ok","service":"collab-server"}
curl http://localhost:8000/health       # liveness: is the process up?
curl http://localhost:8000/health/ready # readiness: 503 unless an LLM is reachable
docker compose exec postgres pg_isready -U devcolab -d devcolab   # or: pg_isready -h localhost -p 5433 -U devcolab -d devcolab
```

---

## Run everything with Docker Compose

To start all services (including PostgreSQL) in containers:

```bash
cd devcolab
cp .env.example .env    # then fill in JWT_SECRET and INTERNAL_API_KEY
docker compose up --build
```

Compose fails fast if `JWT_SECRET`, `INTERNAL_API_KEY`, or `CORS_ORIGIN` are unset.

> The web image bakes `NEXT_PUBLIC_*` values at **build** time. If you change the
> API URLs, rebuild with `docker compose build web` — restarting the container
> alone will not pick them up.

---

## Environment variables

Copy `.env.example` to `.env` at the repo root before running Docker Compose, and
copy each app's `.env.example` into place for local (non-Docker) runs.

```bash
cp .env.example .env
openssl rand -hex 32   # use for JWT_SECRET
openssl rand -hex 32   # use for INTERNAL_API_KEY
```

| Variable | Service | Notes |
|---|---|---|
| `PORT` | collab-server | Defaults to `4000` |
| `DATABASE_URL` | collab-server, ai-service | `postgresql://devcolab:devcolab@localhost:5433/devcolab`. For Neon, use the **pooled** connection string |
| `DIRECT_URL` | `prisma migrate` only | Unpooled connection for running migrations. Same as `DATABASE_URL` for self-hosted Postgres; Neon's **unpooled** string when using Neon |
| `JWT_SECRET` | collab-server | **Required.** Min 16 chars. Boot fails in production if left at a known default |
| `INTERNAL_API_KEY` | collab-server, ai-service | **Required in production.** Must match across both services |
| `CORS_ORIGIN` / `CORS_ORIGINS` | collab-server / ai-service | Comma-separated allowed browser origins. Cannot be `localhost` in production |
| `REDIS_URL` | collab-server | Enables the Socket.IO adapter and shared rate-limit counters. Required for >1 instance |
| `TRUST_PROXY` | collab-server | Proxy hops to trust for client IPs. `0` when exposed directly, `1` behind one load balancer |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | collab-server | Login/register attempts allowed per IP per window. Defaults to 20 per 15 min |
| `NEXT_PUBLIC_COLLAB_SERVER_URL` | web | **Build-time.** Inlined into the client bundle; must be set as a Docker build arg, not at runtime |
| `NEXT_PUBLIC_AI_SERVICE_URL` | web | Build-time, same as above |

> **Note:** DevColab Postgres is exposed on host port **5433** (not 5432) to avoid conflicting with a local PostgreSQL installation.

### Security notes

- Socket.IO connections are authenticated during the handshake via the JWT.
  Client-supplied user ids are ignored — identity always comes from the token.
- Auth endpoints are rate limited (20 per 15 min per IP, tunable with
  `AUTH_RATE_LIMIT_MAX`); AI review is limited to 5 per minute per user. With
  `REDIS_URL` set, limits are shared across instances.
- The client asks `GET /api/auth/me` on load rather than trusting what is in
  `localStorage`, and every authenticated request signs the user out on a 401.
  A stale token lands on the login page instead of rendering an empty session.
- The collab-server refuses to start in production with a default `JWT_SECRET`,
  a missing `INTERNAL_API_KEY`, or a `localhost` CORS origin.

---

## Session visibility

Sessions use a **link-share** model, like a document set to "anyone with the
link":

| Action | Who |
|---|---|
| `GET /api/sessions` (dashboard) | Only sessions you created or have joined |
| `GET /api/sessions/:id` | Anyone authenticated who has the id — opening it enrols you as a participant, so it appears on your dashboard from then on |
| Socket `session:join` | Same rule |
| `POST /api/sessions/:id/files` | **Creator only** — adding code is ownership-based, not role-based |
| `PATCH` / `DELETE /api/sessions/:id` | **Creator only** |

Everyone registers as a `reviewer`; registration does not accept a role, so it
cannot be used to grant yourself one. What you may do inside a session comes
from **owning** it rather than from a role chosen at signup — a global role was
wrong in both directions, letting any author write into anyone's session while
stopping a creator holding the reviewer role from writing into their own.

Session ids are UUIDs, so they are not discoverable by guessing; share the URL
to invite someone. `PATCH` accepts only `title`, `description`,
`repositoryUrl` and `status` — unknown fields are rejected rather than written,
so ownership cannot be reassigned through the API.

## AI review pipeline

Four specialist agents (bug detection, security scanning, anti-pattern analysis,
test generation) fan out **in parallel** from a LangGraph `StateGraph` and join
on a consolidation node that merges and severity-orders their findings. Each
agent is isolated — a failing or timed-out agent degrades only its own findings
and is reported in `agent_errors`, rather than sinking the run.

Reviews are asynchronous. The HTTP request never blocks on the LLM:

```
POST /api/sessions/:sessionId/ai-review   { fileId }   -> 202 { runId, status }
GET  /api/sessions/:sessionId/ai-review               -> paginated run history
GET  /api/sessions/:sessionId/ai-review/:runId        -> run + per-agent status
```

Progress streams to the session room over Socket.IO as each agent finishes:

| Event | Payload |
|---|---|
| `ai:review_started` | `{ runId, fileId, agents[] }` |
| `ai:agent_completed` | `{ runId, agent, issueCount, error }` |
| `comment:created` | the persisted AI comment |
| `ai:review_completed` | `{ runId, summary, totalIssues, engine, degraded }` |
| `ai:review_failed` | `{ runId, error }` |

Every run is persisted: `ai_review_runs` holds the job lifecycle and
`ai_reviews` holds one row per agent (status, issue count, duration, raw JSON
result).

### Durable jobs

With `REDIS_URL` set, reviews are dispatched through a **BullMQ** queue rather
than run in the accepting process. The run id doubles as the job id, so:

- a review queued before a crash is picked up after the restart
- a worker that dies mid-job has it redelivered once the job stalls
- failures retry with exponential backoff (`AI_REVIEW_JOB_ATTEMPTS`, default 2)
- a duplicate trigger for the same run is a no-op
- work is shared across instances, `AI_REVIEW_CONCURRENCY` at a time each

Without `REDIS_URL` the run executes in-process instead, which keeps local
development working but means a restart loses it. A reconciliation sweep marks
runs abandoned beyond twice the review timeout as `failed`, so nothing sits in
`running` forever under either mode.

AI comments are authored by a dedicated `ai-reviewer@devcolab.internal` system
account — not by whoever clicked the button — so authorship stays truthful.

> If the AI service is unreachable, the run falls back to a local regex scanner
> and is labelled `engine: "heuristic-fallback"` with `degraded: true`. The UI
> shows this explicitly; heuristic output is never presented as AI output.

## Deploying to production

> Full step-by-step runbook, including a preflight check and rollback
> procedure: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Summary:

```bash
# 1. Point both DNS records at the host before starting (Caddy needs them
#    resolvable to issue certificates).
#      devcolab.example.com      -> A -> <host ip>
#      api.devcolab.example.com  -> A -> <host ip>

# 2. Configure secrets
cp .env.example .env
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # INTERNAL_API_KEY

# Also set in .env:
#   DEVCOLAB_DOMAIN=devcolab.example.com
#   DEVCOLAB_API_DOMAIN=api.devcolab.example.com
#   CORS_ORIGIN=https://devcolab.example.com
#   NEXT_PUBLIC_COLLAB_SERVER_URL=https://api.devcolab.example.com
#   POSTGRES_PASSWORD=<strong password>

# 3. Check for weak secrets, unresolvable DNS, or an unreachable database
#    before going any further.
./scripts/preflight.sh

# 4. Apply migrations, then start
export DATABASE_URL=postgresql://devcolab:<password>@localhost:5433/devcolab
pnpm db:migrate

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The production overlay differs from the development file in ways that matter:

| | Development | Production overlay |
|---|---|---|
| Postgres / Redis | published to host | internal network only |
| App services | ports published | internal network only |
| Public entry point | each service directly | Caddy on 443, automatic TLS |
| Health check | liveness | **readiness** — unready instances get no traffic |
| Containers | root | non-root users |
| Logs | unbounded | rotated, 10 MB × 3 |

`ai-service` is deliberately never exposed publicly — it is reachable only from
`collab-server` on the internal network, guarded by `INTERNAL_API_KEY`.

### Using Neon instead of the bundled Postgres

The bundled `postgres` container works fine for a single box, but you own
backups yourself. [Neon](https://neon.tech) gives you managed Postgres with a
free tier (0.5 GB, scales to zero when idle) and drops in with no code
changes — just an extra compose overlay.

1. Create a Neon project and database.
2. From the Neon dashboard, copy two connection strings:
   - the **pooled** one (host contains `-pooler`) → `DATABASE_URL`
   - the **unpooled** one → `DIRECT_URL`

   Both need `?sslmode=require`. Put them in `.env`:

   ```bash
   DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/devcolab?sslmode=require
   DIRECT_URL=postgresql://user:pass@ep-xxx.region.aws.neon.tech/devcolab?sslmode=require
   ```

3. Run migrations against Neon (from anywhere with network access — it
   doesn't have to be the production host):

   ```bash
   export DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/devcolab?sslmode=require
   export DIRECT_URL=postgresql://user:pass@ep-xxx.region.aws.neon.tech/devcolab?sslmode=require
   pnpm db:migrate
   ```

4. Start the stack with the extra overlay, which disables the `postgres`
   container and points `collab-server` / `ai-service` at `DATABASE_URL`
   instead:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml \
     -f docker-compose.neon.yml up -d --build
   ```

`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` are unused in this mode
— they only configure the container this overlay disables.

> Free-tier Neon databases scale to zero after inactivity. The first request
> after idle time takes a few seconds while it wakes up; requests after that
> are normal speed. Paid tiers remove this.

### Health probes

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness. Never touches downstreams, so a database blip cannot cause healthy instances to be killed |
| `GET /health/ready` | Readiness. `collab-server` checks Postgres (and reports Redis); `ai-service` checks the LLM provider is actually reachable. Returns `503` when it cannot serve |

### Zero-downtime restarts

Both services drain on `SIGTERM`: connected clients get a `server:shutdown`
event so they can reconnect elsewhere, Socket.IO and the HTTP server close, then
database and Redis connections are released. A 15s cap forces exit so a stuck
connection can never hang a deploy.

### Tracing requests across services

Every request carries an `X-Request-Id` (generated if absent, echoed in the
response). When `collab-server` calls `ai-service`, it sends the **review run
id** as that header — so agent logs in `ai-service` can be joined directly to
the `ai_review_runs` row on the other side.

```bash
curl -sD- -H 'X-Request-Id: my-trace' https://api.devcolab.example.com/health
```

### Scaling out

Set `REDIS_URL` before running more than one `collab-server` instance — it backs
both the Socket.IO adapter (so a broadcast reaches clients on other instances)
and the rate limiter (so limits are shared rather than per-instance). Set
`TRUST_PROXY=1` behind a single load balancer so client IPs — and therefore IP
rate limits — are correct. Leave it at `0` when exposed directly, otherwise
clients can spoof `X-Forwarded-For` and bypass limits.

## Testing

```bash
# collab-server — 100 tests (Vitest)
docker compose up -d postgres   # integration tests need a database
npx prisma migrate deploy
pnpm test

# ai-service — 59 tests (pytest)
cd apps/ai-service
pip install -r requirements-dev.txt
pytest -q
ruff check .

# Browser smoke tests — 16 tests (Playwright)
npx playwright install chromium
pnpm build:collab          # the config builds the web app itself
pnpm test:e2e
```

The Playwright config boots a real collab-server and a freshly built web
bundle, then drives Chromium through the landing page, registration, session
creation, file upload, commenting over Socket.IO, an AI review run, and the
creator-only upload rule, and the stale-token redirect. It rebuilds the web app
on each run because
`NEXT_PUBLIC_*` is inlined at build time — pointing it at the test server via a
runtime variable would silently do nothing.

Tests requiring Postgres skip automatically when none is reachable, so
`pnpm test` still runs the unit suites on a bare checkout. CI runs everything.

CI (`.github/workflows/ci.yml`) additionally verifies that the committed
migration history matches `schema.prisma` via `prisma migrate diff --exit-code`.
That check exists because drift had already shipped once — the initial migration
was missing `comments.file_path`, which broke every inline and AI comment on a
freshly migrated database.

## Tech stack

- **Frontend:** Next.js 14, TypeScript, Tailwind CSS
- **Real-time:** Node.js, Express, Socket.IO
- **AI:** FastAPI, LangGraph, LangChain
- **Database:** PostgreSQL 16
- **Monorepo:** pnpm workspaces
