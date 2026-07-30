#!/usr/bin/env bash
set -euo pipefail

# Run before deploying to production. Fails loudly on weak secrets, missing
# config, or unreachable infrastructure instead of surfacing as a broken
# deploy after the fact. See docs/DEPLOYMENT.md.
#
# Usage: ./scripts/preflight.sh [--skip-dns] [--skip-db]
#
#   --skip-dns   skip DNS resolution checks (useful before records propagate)
#   --skip-db    skip live DATABASE_URL/DIRECT_URL connectivity checks
#
# Reads from already-exported environment variables, falling back to a `.env`
# in the current directory if present.

SKIP_DNS=0
SKIP_DB=0
for arg in "$@"; do
  case "$arg" in
    --skip-dns) SKIP_DNS=1 ;;
    --skip-db) SKIP_DB=1 ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

# Fill in only variables not already exported, so CI/shell-exported secrets
# always win over a local .env file that happens to exist in the same dir.
if [[ -f .env ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ -z "${!key:-}" ]]; then
      export "$key=$value"
    fi
  done < <(grep -v '^\s*#' .env | grep '=')
fi

FAILURES=0
fail() {
  echo "  FAIL: $1" >&2
  FAILURES=$((FAILURES + 1))
}
ok() {
  echo "  ok:   $1"
}

echo "== Secrets =="

# Mirrors the WEAK_JWT_SECRETS set in apps/collab-server/src/lib/env.ts —
# keep both in sync if either changes.
WEAK_JWT_SECRETS=(
  "devcolab-jwt-secret-change-in-production"
  "changeme"
  "change-me"
  "secret"
  "your-secret-key"
  "supersecret"
)
if [[ -z "${JWT_SECRET:-}" ]]; then
  fail "JWT_SECRET is not set"
elif [[ ${#JWT_SECRET} -lt 16 ]]; then
  fail "JWT_SECRET is shorter than 16 characters"
else
  weak=0
  for w in "${WEAK_JWT_SECRETS[@]}"; do
    [[ "$JWT_SECRET" == "$w" ]] && weak=1
  done
  if [[ $weak -eq 1 ]]; then
    fail "JWT_SECRET is a well-known default"
  else
    ok "JWT_SECRET set and not a known default"
  fi
fi

if [[ -z "${INTERNAL_API_KEY:-}" ]]; then
  fail "INTERNAL_API_KEY is not set"
elif [[ ${#INTERNAL_API_KEY} -lt 16 ]]; then
  fail "INTERNAL_API_KEY is shorter than 16 characters"
else
  ok "INTERNAL_API_KEY set"
fi

# Only relevant when the bundled Postgres container is in play — an external
# database (Neon, RDS, ...) manages its own credentials and this var is
# unused (see docker-compose.neon.yml).
WEAK_POSTGRES_PASSWORDS=(
  "devcolab"
  "postgres"
  "password"
  "changeme"
  "change-me"
  "root"
  "admin"
)
if [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
  weak=0
  for w in "${WEAK_POSTGRES_PASSWORDS[@]}"; do
    [[ "$POSTGRES_PASSWORD" == "$w" ]] && weak=1
  done
  if [[ $weak -eq 1 ]]; then
    fail "POSTGRES_PASSWORD is a well-known default — generate one with: openssl rand -hex 32"
  elif [[ ${#POSTGRES_PASSWORD} -lt 12 ]]; then
    fail "POSTGRES_PASSWORD is shorter than 12 characters"
  else
    ok "POSTGRES_PASSWORD set and not a known default"
  fi
else
  ok "POSTGRES_PASSWORD unset (fine if using an external database)"
fi

echo "== Networking =="

if [[ -z "${CORS_ORIGIN:-}" ]]; then
  fail "CORS_ORIGIN is not set"
elif [[ "$CORS_ORIGIN" == *localhost* ]]; then
  fail "CORS_ORIGIN points at localhost — must be your real public origin in production"
else
  ok "CORS_ORIGIN set to $CORS_ORIGIN"
fi

check_dns() {
  local domain="$1"
  local label="$2"
  if [[ -z "$domain" ]]; then
    fail "$label is not set"
    return
  fi
  if [[ "$SKIP_DNS" -eq 1 ]]; then
    ok "$label set (DNS check skipped)"
    return
  fi
  if command -v dig >/dev/null 2>&1 && dig +short "$domain" | grep -q .; then
    ok "$label ($domain) resolves"
  else
    fail "$label ($domain) does not resolve yet — Caddy cannot issue a TLS cert until it does"
  fi
}
check_dns "${DEVCOLAB_DOMAIN:-}" "DEVCOLAB_DOMAIN"
check_dns "${DEVCOLAB_API_DOMAIN:-}" "DEVCOLAB_API_DOMAIN"

echo "== Database =="

check_db() {
  local url="$1"
  local label="$2"
  if [[ -z "$url" ]]; then
    fail "$label is not set"
    return
  fi
  if [[ "$SKIP_DB" -eq 1 ]]; then
    ok "$label set (connectivity check skipped)"
    return
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "  skip: psql not installed, cannot verify $label connectivity"
    return
  fi
  if psql "$url" -c "select 1" >/dev/null 2>&1; then
    ok "$label is reachable"
  else
    fail "$label did not accept a connection"
  fi
}
check_db "${DATABASE_URL:-}" "DATABASE_URL"
if [[ -n "${DIRECT_URL:-}" ]]; then
  check_db "${DIRECT_URL:-}" "DIRECT_URL"
fi

echo
if [[ $FAILURES -gt 0 ]]; then
  echo "$FAILURES check(s) failed. Fix these before deploying." >&2
  exit 1
fi
echo "All checks passed."
