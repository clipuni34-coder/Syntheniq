#!/usr/bin/env bash
# Syntheniq — Codespace startup script.
# Builds the web app (static export) and API, then starts the unified
# server on port 3000 (serves both the studio UI and the API backend).
set -euo pipefail

echo "[codespace] Installing dependencies..."
npm ci

echo "[codespace] Building web app (static export)..."
npm run build:web

echo "[codespace] Building API..."
npm run build:api

# Port 3000 is the Codespace default forwarded port — GitHub Codespaces
# automatically forwards it and provides an HTTPS preview URL.
# The API server (host: '::') supports both IPv4 and IPv6, working with
# Safari, Chrome, Firefox, and mobile browsers.
export PORT=3000
export WEB_OUT_DIR="$(pwd)/apps/web/out"
export SYNTHENIQ_DATA="$(pwd)/apps/api/data"

echo "[codespace] Starting Syntheniq on port $PORT..."
echo "[codespace] Open the Codespaces 'Ports' tab and click the preview for port 3000"
exec node apps/api/dist/server.js
