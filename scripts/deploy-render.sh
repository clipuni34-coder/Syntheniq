#!/bin/bash
# deploy-render.sh — Render.com deployment automation
# Usage: bash deploy-render.sh
# Requires: render.com CLI (npm install -g render-cli) or manual setup via dashboard

set -e

echo "=== WinGo Racer — Render.com Deployment ==="
echo ""

# Check if render CLI is available
if command -v render &> /dev/null; then
  echo "Render CLI found: $(which render)"
  
  # Step 1: Login (if not already logged in)
  echo "[1/4] Logging in to Render..."
  render login
  
  # Step 2: Deploy a new web service
  echo "[2/4] Creating web service on Render..."
  render services create \
    --name wingo-racer \
    --type web_service \
    --plan free \
    --region oregon \
    --build-command "npm install" \
    --start-command "node app.js" \
    --health-check-path /health \
    --env FB999_PHONE=2349121493739 \
    --env FB999_PASSWORD=Drewziwugod6 \
    2>&1
  
  echo "[3/4] Setting environment variables..."
  render env set FB999_PHONE=2349121493739
  render env set FB999_PASSWORD=Drewziwugod6
  render env set NODE_ENV=production
  render env set PORT=3000
  
  echo "[4/4] Deploy initiated!"
  echo "Check status at: https://dashboard.render.com"
  
else
  echo "Render CLI not found. Manual deployment instructions:"
  echo ""
  echo "1. Install render CLI: npm install -g render-cli"
  echo "2. Or deploy manually via the Render dashboard:"
  echo "   a. Go to https://dashboard.render.com"
  echo "   b. Click 'New +' → 'Web Service'"
  echo "   c. Connect your GitHub repo (or use 'Build from Dockerfile')"
  echo "   d. Set environment variables:"
  echo "      - FB999_PASSWORD = Drewziwugod6"
  echo "   e. Build command: npm install"
  echo "   f. Start command: node app.js"
  echo "   g. Health check path: /health"
  echo "   h. Plan: Free (512MB RAM, sufficient)"
  echo ""
  echo "Render does NOT require a credit card for free tier."
fi

echo ""
echo "=== After deployment ==="
echo "App URL: https://wingo-racer.onrender.com"
echo "Health:  https://wingo-racer.onrender.com/health"
echo "Status:  https://wingo-racer.onrender.com/api/status"
