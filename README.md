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
curl http://localhost:8000/health       # {"status":"ok","service":"ai-service"}
docker compose exec postgres pg_isready -U devcolab -d devcolab   # or: pg_isready -h localhost -p 5433 -U devcolab -d devcolab
```

---

## Run everything with Docker Compose

To start all services (including PostgreSQL) in containers:

```bash
cd devcolab
docker compose up --build
```

---

## Environment variables

| Variable       | Service        | Default                                      |
|----------------|----------------|----------------------------------------------|
| `PORT`         | collab-server  | `4000`                                       |
| `CORS_ORIGIN`  | collab-server  | `http://localhost:3000`                      |
| `DATABASE_URL` | collab-server, ai-service | `postgresql://devcolab:devcolab@localhost:5433/devcolab` |

> **Note:** DevColab Postgres is exposed on host port **5433** (not 5432) to avoid conflicting with a local PostgreSQL installation.

Copy `.env.example` files into each app as needed (future phases).

---

## Tech stack

- **Frontend:** Next.js 14, TypeScript, Tailwind CSS
- **Real-time:** Node.js, Express, Socket.IO
- **AI:** FastAPI, LangGraph, LangChain
- **Database:** PostgreSQL 16
- **Monorepo:** pnpm workspaces
