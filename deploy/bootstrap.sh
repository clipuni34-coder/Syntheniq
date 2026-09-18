#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Syntheniq — one-shot host bootstrap for a Linux machine (home PC / NAS /
# Oracle VM). Installs Docker + Tailscale if missing, prepares .env, builds
# and starts the container, and publishes it over Tailscale Serve.
#
#   Usage:  curl ... deploy/bootstrap.sh | bash   (or: bash deploy/bootstrap.sh)
#   Safe to re-run: every step is idempotent (checks before acting).
#
# What it does NOT do: it never touches existing data, never removes anything,
# never opens router ports, and never writes API keys (you fill .env yourself).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="${SYNTHENIQ_DIR:-$HOME/syntheniq}"
PORT=8787

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

# ── 0. sanity ───────────────────────────────────────────────────────────────
if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is for Linux hosts. For macOS/Windows, follow deploy/RUNBOOK.md."
  exit 1
fi
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) say "host arch x86-64 — standard image (headless Chrome pre-cached)";;
  aarch64|arm64)
    say "host arch ARM64 — building with INSTALL_CHROMIUM=1 (Chrome-for-Testing has no linux/arm64 build)"
    export INSTALL_CHROMIUM=1
    ;;
  *) warn "unexpected arch $ARCH — proceeding, but verify the image build";;
esac

SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null; then SUDO="sudo"; fi

# ── 1. Docker Engine ────────────────────────────────────────────────────────
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  say "docker already installed: $(docker --version)"
else
  say "installing Docker Engine (official get.docker.com script)..."
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker
fi

# ── 2. Tailscale ────────────────────────────────────────────────────────────
if command -v tailscale >/dev/null; then
  say "tailscale already installed: $(tailscale version | head -1)"
else
  say "installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | $SUDO sh
  $SUDO systemctl enable --now tailscaled
fi

# ── 3. repo + .env ──────────────────────────────────────────────────────────
if [ ! -d "$REPO_DIR/.git" ]; then
  say "cloning Syntheniq to $REPO_DIR"
  git clone https://github.com/clipuni34-coder/Syntheniq.git "$REPO_DIR"
fi
cd "$REPO_DIR"
git fetch origin dev/finish-pipeline 2>/dev/null || true
if [ -f .env ]; then
  say ".env already present — leaving it untouched"
else
  cp .env.example .env
  chmod 600 .env
  warn "edit .env now and add at least one AI key (OPENAI_API_KEY and/or GEMINI_API_KEY)"
  warn "      + set SYNTHENIQ_PASSWORD.  Then re-run this script."
  echo "      (Re-running is safe: it will pick up where it left off.)"
  grep -qE '^OPENAI_API_KEY=.' .env || grep -qE '^GEMINI_API_KEY=.' .env || {
    echo "      .env has no AI key yet — aborting before the build (the app would"
    echo "      still run in heuristic mode, but you probably want a key first)."
    exit 0
  }
fi

# ── 4. build + start ────────────────────────────────────────────────────────
say "building image (first build ≈ 5–10 min: web export + deps + chrome + whisper model)"
docker compose up -d --build

say "waiting for the API to become healthy..."
for i in $(seq 1 60); do
  CODE=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/health" 2>/dev/null || true)
  [ "$CODE" = "401" ] && break
  sleep 3
done
CODE=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/health" 2>/dev/null || echo 000)
if [ "$CODE" != "401" ]; then
  warn "API not healthy yet (HTTP $CODE). Check: docker compose logs --tail 50"
  exit 1
fi
say "API is up on http://127.0.0.1:$PORT"

# ── 5. publish over Tailscale ───────────────────────────────────────────────
if tailscale status >/dev/null 2>&1; then
  say "tailscale already connected"
else
  warn "tailscale is not connected yet — run:  sudo tailscale up"
  warn "(then re-run this script to finish the Serve step)"
  exit 0
fi
if ! tailscale serve status >/dev/null 2>&1 || ! tailscale serve status | grep -q "$PORT"; then
  say "publishing over Tailscale Serve (HTTPS, Let's Encrypt, no open ports)..."
  tailscale serve --bg --https 443 "127.0.0.1:$PORT"
fi
URL=$(tailscale status --json | python3 -c "import sys,json; print(json.load(sys.stdin)['Self']['Name'])" | sed 's/\..*//')
MAGICAL=$(tailscale serve status | grep -oE 'https://[a-z0-9.-]+\.ts\.net' | head -1)

# ── 6. done ─────────────────────────────────────────────────────────────────
say "BOOTSTRAP COMPLETE"
echo
echo "  Your Syntheniq URL:   ${MAGICAL:-https://$URL.<your-tailnet>.ts.net}"
echo "  (exact URL: run  'tailscale serve status'  )"
echo
echo "  Next: on your iPhone install the free Tailscale app, log in with the"
echo "  same account, open Safari, go to that URL, and enter your passcode."
echo
echo "  Verification checklist: see deploy/RUNBOOK.md (tests, E2E, crash test)."
