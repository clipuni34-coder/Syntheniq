#!/bin/bash
# Railway deployment startup script for Syntheniq Web
set -e

echo "=== Installing dependencies ==="
npm install

echo "=== Starting Syntheniq Web ==="
npx next start -p $PORT 2>/dev/null || npx next dev -p $PORT
