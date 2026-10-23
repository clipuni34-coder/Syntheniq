#!/bin/bash
# Syntheniq persistent service startup script
# Runs forever, ensuring API + tunnel stay alive

set -e

# Install dependencies
echo "[setup] Installing system dependencies..."
which ffmpeg 2>/dev/null || apt-get update -qq && apt-get install -y -qq ffmpeg python3 python3-pip
python3 -c "from faster_whisper import WhisperModel" 2>/dev/null || pip install --break-system-packages faster-whisper

# Install Node deps
echo "[setup] Installing Node deps..."
cd /workspace/app/apps/api && npm install --silent 2>/dev/null
cd /workspace/app/apps/web && npm install --silent 2>/dev/null && npm run build 2>/dev/null

# Start API server
echo "[start] Starting API server on port 8788..."
cd /workspace/app/apps/api
export PATH="/workspace/app/apps/api/node_modules/.bin:/usr/bin:/usr/local/bin:/usr/local/sbin:$PATH"
export PORT=8788
export WEB_OUT_DIR=/workspace/app/apps/web/out

while true; do
  tsx src/server.ts &
  API_PID=$!
  echo "[api] Server started PID=$API_PID"

  # Wait for API to be healthy
  for i in $(seq 1 30); do
    if curl -s http://localhost:8788/health 2>/dev/null | grep -q '"ok":true'; then
      echo "[api] Health check passed"
      break
    fi
    sleep 1
  done

  # Start Cloudflare tunnel
  echo "[tunnel] Starting Cloudflare tunnel..."
  /tmp/cloudflared tunnel --url http://localhost:8788 > /tmp/tunnel.log 2>&1 &
  TUNNEL_PID=$!
  echo "[tunnel] Started PID=$TUNNEL_PID"

  # Wait forever, restart services if they crash
  while true; do
    if ! kill -0 $API_PID 2>/dev/null; then
      echo "[api] Process died, restarting..."
      break
    fi
    if ! kill -0 $TUNNEL_PID 2>/dev/null; then
      echo "[tunnel] Process died, restarting..."
      kill $API_PID 2>/dev/null
      break
    fi
    sleep 5
  done

  # Clean up before restart
  kill $API_PID 2>/dev/null || true
  kill $TUNNEL_PID 2>/dev/null || true
  pkill -f "tsx src/server.ts" 2>/dev/null || true
  pkill -f cloudflared 2>/dev/null || true
  sleep 3
done
