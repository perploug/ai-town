#!/usr/bin/env bash
# Bring up a local, self-hosted Convex backend for AI Town and deploy the
# functions into it, so the MCP server + e2e suite have something to talk to.
#
# One-time-ish: safe to re-run. Requires Docker + docker compose.
#
#   ./mcp-server/scripts/setup-e2e-backend.sh
#
# Afterwards:
#   cd mcp-server && npm test        # runs the e2e suite
#   npm --prefix mcp-server start    # runs the MCP server for real clients
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> Starting self-hosted Convex backend (docker compose up -d backend)"
docker compose up -d backend

echo "==> Waiting for the backend to become healthy"
for i in $(seq 1 40); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q backend)" 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && break
  sleep 3
done
if [ "${status:-}" != "healthy" ]; then
  echo "Backend did not become healthy. Check: docker compose logs backend" >&2
  exit 1
fi

echo "==> Generating admin key"
KEY="$(docker compose exec -T backend ./generate_admin_key.sh | tail -1 | tr -d '\r')"

# The Convex CLI reads these from .env.local for self-hosted deployments.
touch .env.local
# Remove any prior self-hosted entries, then append fresh ones.
grep -v -E '^CONVEX_SELF_HOSTED_(URL|ADMIN_KEY)=' .env.local > .env.local.tmp || true
mv .env.local.tmp .env.local
{
  echo "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210"
  echo "CONVEX_SELF_HOSTED_ADMIN_KEY=$KEY"
} >> .env.local

echo "==> Deploying Convex functions (npx convex dev --once)"
npx convex dev --once

echo "==> Creating an empty default world (npx convex run init)"
npx convex run init

echo
echo "Backend ready at http://127.0.0.1:3210"
echo "Run the e2e suite with:  cd mcp-server && npm test"
