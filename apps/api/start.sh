#!/bin/bash
# Railway deployment startup script for Syntheniq API
set -e

echo "=== Installing system dependencies ==="
apt-get update -qq
apt-get install -y -qq ffmpeg python3-dev python3-pip espeak-ng

echo "=== Installing Python packages ==="
pip3 install faster-whisper==1.2.1 torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu 2>&1 | tail -5 || pip3 install faster-whisper==1.2.1 2>&1 | tail -5

echo "=== Building API ==="
npm install
npm run build

echo "=== Starting Syntheniq API ==="
node dist/server.js
