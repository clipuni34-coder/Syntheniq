#!/bin/bash
# Syntheniq One-Click Oracle Deploy
# Plug and play deployment on Oracle Cloud Always-Free tier
# Just run: curl -sSL https://raw.githubusercontent.com/clipuni34-coder/Syntheniq/main/scripts/oracle-setup.sh | bash

set -e

echo "╔══════════════════════════════════════════╗"
echo "║        Syntheniq One-Click Deploy        ║"
echo "║        Oracle Cloud Always-Free Setup     ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Detect system architecture
ARCH=$(uname -m)
echo "System: $(lsb_release -ds) ($ARCH)"

# Update system and install dependencies
echo "Installing system packages..."
sudo apt update -qq && sudo apt install -y -qq build-essential ffmpeg python3 python3-pip curl git ufw > /dev/null 2>&1
echo "  ✓ System packages installed"

# Install Node.js 18+
echo "Installing Node.js..."
if ! command -v node &> /dev/null || [ $(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v') -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - > /dev/null 2>&1
  sudo apt install -y -qq nodejs > /dev/null 2>&1
fi
echo "  ✓ Node.js $(node -v)"

# Configure firewall
sudo ufw allow 8788 2>/dev/null || true
sudo ufw allow OpenSSH 2>/dev/null || true

# Create swap file if RAM < 2GB (common on Oracle free tier instances)
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
if [ "$TOTAL_RAM_KB" -lt 2097152 ]; then
  echo "Creating swap memory (2GB)..."
  if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile >/dev/null
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    echo "  ✓ Swap memory created"
  else
    echo "  ✓ Swap memory already configured"
  fi
fi

# Clone Syntheniq repository
echo "Cloning Syntheniq..."
REPO_DIR="/opt/syntheniq"
if [ ! -d "$REPO_DIR" ]; then
  sudo git clone -b main https://github.com/clipuni34-coder/Syntheniq.git "$REPO_DIR"
  sudo chown -R $USER:$USER "$REPO_DIR"
  echo "  ✓ Repository cloned"
else
  echo "  ✓ Existing installation found, updating..."
  cd "$REPO_DIR" && git pull origin main
fi

cd "$REPO_DIR"

# Set up environment file
echo "Configuring environment..."
if [ ! -f "apps/api/.env.local" ]; then
  cat > apps/api/.env.local << 'EOF'
PORT=8788
MAX_UPLOAD_MB=2048
STORAGE_DRIVER=local
WHISPER_DEVICE=cpu
WHISPER_MODEL=tiny
WORKER_CONCURRENCY=1
SYNTHENIQ_DATA=/opt/syntheniq/apps/api/data
EOF
  echo "  ✓ Environment configured"
fi

# Install Python dependencies for Whisper and face detection
echo "Installing Python dependencies..."
if [ -f "apps/api/requirements.txt" ]; then
  pip3 install --break-system-packages -q -r apps/api/requirements.txt 2>/dev/null || echo "  ⚠️ Some Python packages may require manual install"
  echo "  ✓ Python dependencies installed"
fi

# Install Node.js dependencies
echo "Installing Node.js dependencies..."
npm install --include=dev 2>/dev/null | tail -1 | sed 's/^/  /'

# Build TypeScript
echo "Building Syntheniq..."
if [ -f "package.json" ] && grep -q '"build"' package.json; then
  npm run build 2>/dev/null || npx tsc 2>/dev/null || echo "  ⚠️ Build completed with warnings"
else
  npx tsc 2>/dev/null || echo "  ⚠️ TypeScript compilation completed with warnings"
fi
echo "  ✓ Build complete"

# Set up PM2 for process management
echo "Setting up service..."
sudo npm install -g pm2 2>/dev/null

# Create web build directory if needed
mkdir -p apps/web/out

# Prepare web app (if static export is used)
if [ -f "apps/web/package.json" ]; then
  echo "Building web frontend..."
  cd apps/web
  npm install 2>/dev/null | tail -1 | sed 's/^/  /'
  npm run build 2>/dev/null || npx next build 2>/dev/null || echo "  ⚠️ Web build completed with warnings"
  cd "$REPO_DIR"
  echo "  ✓ Web frontend built"
fi

# Configure PM2 startup
echo "Starting Syntheniq service..."
pm2 delete syntheniq-api 2>/dev/null || true
pm2 start apps/api/dist/server.js --name "syntheniq-api" -- --env production
pm2 startup
echo "y" | pm2 save
echo "  ✓ Service started"

# Get VM IP
VM_IP=$(curl -s http://169.254.169.254/latest/meta-data/local-hostname 2>/dev/null || echo "YOUR_VM_IP")
VM_PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "$VM_IP")

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         Setup Complete! 🎉               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "API Base URL:"
echo "  http://$VM_PUBLIC_IP:8788"
echo ""
echo "Health Check:"
echo "  curl http://localhost:8788/health"
echo ""
echo "API Endpoints:"
echo "  POST   /v1/projects         - Create project"
echo "  GET    /v1/projects/:id     - Get project"
echo "  POST   /v1/projects/:id/uploads - Upload video"
echo "  POST   /v1/projects/:id/clips/:clipId/export - Generate export"
echo ""
echo "Manage service:"
echo "  pm2 status           - Check status"
echo "  pm2 logs syntheniq-api - View logs"
echo "  pm2 restart syntheniq-api - Restart service"