#!/bin/bash
# deploy.sh — Full Fly.io deployment automation
# Usage: bash deploy.sh

set -e

export FLYCTL_INSTALL="$HOME/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"
export NODE_ENV=production

echo "=== WinGo Racer — Fly.io Deployment ==="
echo ""

# Step 1: Start flyctl auth login in background
echo "[1/5] Starting Fly.io authentication..."
flyctl auth login > /tmp/fly_auth.log 2>&1 &
FLYCTL_PID=$!

# Wait for the auth URL to appear
echo "    Waiting for auth URL..."
for i in $(seq 1 15); do
  if grep -q "fly.io/app/auth/cli" /tmp/fly_auth.log 2>/dev/null; then
    break
  fi
  sleep 1
done

# Extract the auth URL
AUTH_URL=$(grep -oP 'https://fly\.io/app/auth/cli/\S+' /tmp/fly_auth.log | head -1)
if [ -z "$AUTH_URL" ]; then
  echo "    ERROR: Could not find auth URL in flyctl output"
  echo "    flyctl output:"
  cat /tmp/fly_auth.log
  exit 1
fi
echo "    Auth URL: $AUTH_URL"

# Step 2: Complete authentication via Puppeteer
echo "[2/5] Completing browser authentication via Puppeteer..."
cd /workspace/app
node scripts/fly_auth_complete.js "$AUTH_URL" 2>&1

# Wait for flyctl auth login to finish
echo "    Waiting for flyctl to detect auth completion..."
for i in $(seq 1 10); do
  if ! kill -0 $FLYCTL_PID 2>/dev/null; then
    break
  fi
  sleep 1
done

# Check auth
echo "    Checking authentication..."
flyctl auth whoami 2>&1
echo ""

# Step 3: Create the app
echo "[3/5] Creating Fly.io app..."
flyctl apps create wingo-racer --org personal 2>&1 || echo "    App may already exist, continuing..."
echo ""

# Step 4: Set secrets
echo "[4/5] Setting secrets..."
flyctl secrets set \
  FB999_PHONE=2349121493739 \
  FB999_PASSWORD=Drewziwugod6 \
  --app wingo-racer 2>&1
echo ""

# Step 5: Deploy
echo "[5/5] Deploying..."
flyctl deploy --app wingo-racer 2>&1
echo ""

echo "=== Deployment Complete ==="
echo "App URL: https://wingo-racer.fly.dev"
echo "Health: https://wingo-racer.fly.dev/health"
echo "Status: https://wingo-racer.fly.dev/api/status"
