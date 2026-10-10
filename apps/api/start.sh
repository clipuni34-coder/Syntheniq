#!/bin/bash
# Railway startup script for Syntheniq API
# Handles low-memory environments (2GB RAM) by adding swap if needed

set -e

# Add swap if under 2GB RAM (Railway free tier)
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
if [ "$TOTAL_RAM_KB" -lt 2097152 ]; then
  echo "Low memory detected, configuring swap..."
  # Create swap file if it doesn't exist
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress 2>&1
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi

# Sync data directory
mkdir -p "${SYNTHENIQ_DATA:-/data}"

# Start the API server
exec node dist/server.js
