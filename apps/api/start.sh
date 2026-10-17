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

# Ensure Python dependencies are installed (used by whisper_local.py and face_detect.py)
REQUIREMENTS_FILE="$(dirname "$0")/requirements.txt"

python3_available() {
  command -v python3 >/dev/null 2>&1
}

python_packages_available() {
  python3 -c "import faster_whisper; import cv2; import numpy" 2>/dev/null
}

if python3_available && [ -f "$REQUIREMENTS_FILE" ]; then
  if ! python_packages_available; then
    echo "Installing Python dependencies from requirements.txt..."
    if pip3 install --break-system-packages -r "$REQUIREMENTS_FILE" 2>&1; then
      echo "Python dependencies installed."
    else
      echo "Warning: Failed to install Python dependencies." >&2
    fi
  else
    echo "Python dependencies already available."
  fi
else
  if ! python3_available; then
    echo "Warning: python3 is not available. Transcription and face detection may not work." >&2
  fi
fi

# Start the API server
exec node dist/server.js
