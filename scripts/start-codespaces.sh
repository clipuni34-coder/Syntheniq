#!/usr/bin/env bash
# Syntheniq — Codespace entrypoint.
# Builds the web app (static export) and API, then starts the unified
# server on port 8787 (serves both the studio UI and the API backend).
set -euo pipefail

echo "[codespace] Installing dependencies..."
npm ci

echo "[codespace] Building web app (static export)..."
npm run build:web

echo "[codespace] Building API..."
npm run build:api

echo "[codespace] Starting Syntheniq API + engine on port 8787..."
export PORT=8787
export WEB_OUT_DIR="$(pwd)/apps/web/out"
export SYNTHENIQ_DATA="$(pwd)/apps/api/data"
nohup node apps/api/dist/server.js > /tmp/syntheniq.log 2>&1 &
echo $! > /tmp/syntheniq.pid

echo "[codespace] Waiting for server to be ready..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:8787/v1/health" >/dev/null 2>&1; then
    echo "[codespace] Server is ready at http://localhost:8787"
    break
  fi
  sleep 1
done

echo "[codespace] Logs:"
cat /tmp/syntheniq.log
echo "[codespace] Server PID: $(cat /tmp/syntheniq.pid)"
