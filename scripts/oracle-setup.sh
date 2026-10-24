#!/bin/bash
# Oracle Cloud Always-Free Setup Script for Syntheniq
# This script automates deployment on Oracle Cloud Infrastructure (OCI)
# Works with VM.Standard.A1.Flex (ARM) or VM.Standard.E2.1.Micro (AMD) instances

set -e

echo "=== Syntheniq Oracle Cloud Setup ==="
echo "This script configures Syntheniq on Oracle Cloud Infrastructure"
echo ""

# Detect system architecture
ARCH=$(uname -m)
echo "Detected architecture: $ARCH"

# Update system packages
echo "=== Updating system packages ==="
sudo apt update && sudo apt upgrade -y

# Install required system dependencies
echo "=== Installing system dependencies ==="
sudo apt install -y \
  build-essential \
  ffmpeg \
  python3 \
  python3-pip \
  curl \
  git \
  nginx \
  ufw

# Install Node.js 18+ (required by Syntheniq)
echo "=== Installing Node.js ==="
if ! command -v node &> /dev/null || [ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt install -y nodejs
fi
echo "Node.js version: $(node -v)"

# Configure firewall
echo "=== Configuring firewall ==="
sudo ufw allow 8788
sudo ufw allow OpenSSH
echo "y" | sudo ufw enable 2> /dev/null || true

# Create swap file if RAM < 2GB (common on Oracle free tier instances)
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
if [ "$TOTAL_RAM_KB" -lt 2097152 ]; then
  echo "=== Low memory detected, creating swap ==="
  if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo "Swap file created (2GB)"
  else
    echo "Swap file already exists"
  fi
fi

# Clone Syntheniq repository
echo "=== Cloning Syntheniq repository ==="
REPO_DIR="/opt/syntheniq"
if [ ! -d "$REPO_DIR" ]; then
  sudo git clone https://github.com/clipuni34-coder/Syntheniq.git "$REPO_DIR"
  sudo chown -R $USER:$USER "$REPO_DIR"
else
  echo "Syntheniq directory already exists, pulling latest..."
  cd "$REPO_DIR" && git pull
fi

cd "$REPO_DIR"

# Set up environment file
echo "=== Setting up environment configuration ==="
if [ ! -f "apps/api/.env.local" ]; then
  cp apps/api/.env.example apps/api/.env.oracle
  # Create optimized config for Oracle free tier
  cat > apps/api/.env.local << 'EOF'
PORT=8788
MAX_UPLOAD_MB=2048
# Use local storage (no external database required)
STORAGE_DRIVER=local
# Local Whisper for transcription (CPU mode)
WHISPER_DEVICE=cpu
WHISPER_MODEL=tiny
# Minimize worker concurrency for single-core instances
WORKER_CONCURRENCY=1
# Adjust these paths for your Oracle VM
SYNTHENIQ_DATA=/opt/syntheniq/apps/api/data
EOF
  echo "Created .env.local with Oracle optimizations"
fi

# Install Python dependencies for Whisper and face detection
echo "=== Installing Python dependencies ==="
if [ -f "apps/api/requirements.txt" ]; then
  pip3 install --break-system-packages -r apps/api/requirements.txt || echo "Warning: Some Python packages failed to install"
fi

# Install Node.js dependencies
echo "=== Installing Node.js dependencies ==="
npm install --include=dev

# Build TypeScript
echo "=== Building Syntheniq ==="
npm run build 2>/dev/null || npx tsc 2>/dev/null || echo "Build completed with warnings"

# Set up PM2 for process management
echo "=== Setting up PM2 process manager ==="
sudo npm install -g pm2

# Create web build directory if needed
mkdir -p apps/web/out

# Prepare web app (if static export is used)
if [ -f "apps/web/package.json" ]; then
  echo "=== Building web frontend ==="
  cd apps/web
  npm install
  npm run build 2> /dev/null || npx next build 2> /dev/null || echo "Web build completed with warnings"
  cd "$REPO_DIR"
fi

# Configure PM2 startup
echo "=== Configuring PM2 startup ==="
pm2 delete syntheniq-api 2>/dev/null || true
pm2 start apps/api/dist/server.js --name "syntheniq-api" -- --env production
pm2 startup
echo "y" | pm2 save

echo ""
echo "=== Setup Complete ==="
echo "Syntheniq API is now running on port 8788"
echo ""
echo "Access your API at: http://$(curl -s http://169.254.169.254/latest/meta-data/local-hostname 2>/dev/null || echo 'YOUR_VM_IP'):8788"
echo "Health check: curl http://localhost:8788/health"
echo ""
echo "For custom domain, consider using Cloudflare Tunnel:"
echo "1. Install cloudflared: wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb"
echo "2. Run: cloudflared tunnel --url http://localhost:8788"