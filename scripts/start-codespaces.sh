#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Syntheniq — Codespaces one-command start.
#
#   bash scripts/start-codespaces.sh            # preflight + start (foreground)
#   bash scripts/start-codespaces.sh --ensure-only   # preflight checks, exit
#
# What it does:
#   1. verifies the whole toolchain (node 22, ffmpeg+drawtext, ffprobe,
#      faster-whisper + model, HyperFrames CLI + headless Chrome, builds)
#   2. loads environment: GitHub Codespaces secrets (real env vars) always
#      win; a local env file fills in anything still unset. NEVER prints
#      secret values.
#   3. starts the existing Fastify server, which already binds 0.0.0.0 —
#      GitHub port forwarding then exposes it as HTTPS on your phone.
#
# No product code is modified; this only sets the environment the app
# already understands.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ENSURE_ONLY=0
[ "${1:-}" = "--ensure-only" ] && ENSURE_ONLY=1

PORT="${PORT:-3000}"
export PORT
if [ -z "${SYNTHENIQ_DATA:-}" ] && [ -d /workspaces/Syntheniq ]; then
  export SYNTHENIQ_DATA=/workspaces/Syntheniq/.syntheniq-data
else
  export SYNTHENIQ_DATA="${SYNTHENIQ_DATA:-$HOME/syntheniq-data}"
fi
export SYNTHENIQ_PASSWORD="${SYNTHENIQ_PASSWORD:-syntheniq-2026}"
export SYNTHENIQ_WHISPER_MODEL="${SYNTHENIQ_WHISPER_MODEL:-small}"
export NODE_ENV="${NODE_ENV:-production}"
export WEB_OUT_DIR="${WEB_OUT_DIR:-$REPO/apps/web/out}"
# Main-disk TMPDIR: the Codespace's /tmp is a RAM-backed tmpfs and the
# HyperFrames CLI hard-fails on tight temp space.
export TMPDIR="${TMPDIR:-$HOME/tmp}"
mkdir -p "$TMPDIR" "$SYNTHENIQ_DATA"

# ── env file (lives OUTSIDE the repo — never committed, never in git) ──────
# Only fills variables that are NOT already set, so GitHub Codespaces
# secrets (injected as real environment variables) always take precedence.
ENVFILE="${SYNTHENIQ_ENV_FILE:-$HOME/.syntheniq.env}"
if [ -f "$ENVFILE" ]; then
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="$(echo "$key" | tr -d '[:space:]')"
    case "$key" in *=*|'') continue ;; esac
    if [ -z "${!key:-}" ]; then
      export "$key=$val"
    fi
  done < "$ENVFILE"
  echo "[start] env file: $ENVFILE (existing env/secrets take precedence)"
else
  echo "[start] no env file ($ENVFILE) — keys come from Codespaces secrets or not at all"
fi

# ── preflight: verify the whole toolchain ───────────────────────────────────
echo "═══ Syntheniq preflight ═══"
FAIL=0

node_major="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)" || node_major=0
if [ "$node_major" -ge 22 ]; then
  echo "  node        : $(node -v) ok"
else
  echo "  node        : FAIL — need Node 22+, got $(node -v 2>/dev/null || echo none)"; FAIL=1
fi

if command -v ffmpeg >/dev/null 2>&1; then
  # capture first — `ffmpeg -filters | grep -q` false-negatives under
  # pipefail (grep exits early → ffmpeg gets SIGPIPE → pipeline "fails")
  FF_FILTERS="$(ffmpeg -hide_banner -filters 2>/dev/null || true)"
  case "$FF_FILTERS" in
    *drawtext*) echo "  ffmpeg      : ok (drawtext present)";;
    *) echo "  ffmpeg      : FAIL — no drawtext filter (captions require it)"; FAIL=1;;
  esac
else
  echo "  ffmpeg      : FAIL — not on PATH"; FAIL=1
fi
command -v ffprobe >/dev/null 2>&1 && echo "  ffprobe     : ok" || { echo "  ffprobe     : FAIL — not on PATH"; FAIL=1; }

if python3 -c 'import faster_whisper' 2>/dev/null; then
  echo "  whisper     : faster-whisper import ok"
else
  echo "  whisper     : FAIL — pip3 install --break-system-packages faster-whisper"; FAIL=1
fi

if [ -x node_modules/.bin/hyperframes ]; then
  echo "  hyperframes : CLI present"
else
  echo "  hyperframes : FAIL — run: npm ci"; FAIL=1
fi
[ -f apps/api/dist/server.js ] && echo "  api build   : ok" || { echo "  api build   : FAIL — run: npm run build:api"; FAIL=1; }
[ -f "$WEB_OUT_DIR/index.html" ] && echo "  web build   : ok" || { echo "  web build   : FAIL — run: npm run build:web"; FAIL=1; }

if [ "$FAIL" -eq 0 ]; then
  # Whisper model (idempotent — downloads only if not cached yet).
  if python3 -c "from faster_whisper import WhisperModel; WhisperModel('$SYNTHENIQ_WHISPER_MODEL', device='cpu', compute_type='int8')" 2>/dev/null; then
    echo "  whisper     : model '$SYNTHENIQ_WHISPER_MODEL' (int8) loads ok"
  else
    echo "  whisper     : FAIL — model '$SYNTHENIQ_WHISPER_MODEL' could not load"; FAIL=1
  fi
  # HyperFrames headless Chrome (idempotent — downloads only if missing).
  # HyperFrames installs 'chrome-headless-shell' under ~/.cache/hyperframes
  # (full Chrome under ~/.cache/puppeteer on some versions).
  if node_modules/.bin/hyperframes browser ensure >/dev/null 2>&1 \
     || node_modules/.bin/hyperframes browser >/dev/null 2>&1; then
    CHROME_BIN="$(find "$HOME/.cache/hyperframes" -type f \( -name chrome -o -name chrome-headless-shell \) 2>/dev/null | head -1 || true)"
    [ -z "$CHROME_BIN" ] && CHROME_BIN="$(find "$HOME/.cache" -type f -name chrome -path '*chrome-linux*' 2>/dev/null | head -1 || true)"
    echo "  chrome      : ok ${CHROME_BIN:+($CHROME_BIN)}"
  else
    echo "  chrome      : FAIL — hyperframes browser ensure failed"; FAIL=1
  fi
fi

[ "$FAIL" -ne 0 ] && { echo "preflight FAILED — fix the items above, then re-run."; exit 1; }
echo "preflight OK"

# ── key presence (values are NEVER printed) ─────────────────────────────────
for k in OPENAI_API_KEY GEMINI_API_KEY XAI_API_KEY; do
  if [ -n "${!k:-}" ]; then echo "  $k: set"; else echo "  $k: not set"; fi
done
[ -n "${AI_PROVIDER:-}" ] && echo "  AI_PROVIDER : $AI_PROVIDER" || echo "  AI_PROVIDER : auto-pick (first configured provider)"
[ -n "${AI_MODEL:-}" ] && echo "  AI_MODEL    : $AI_MODEL" || echo "  AI_MODEL    : per-provider defaults"

if [ "$ENSURE_ONLY" -eq 1 ]; then
  echo "ensure-only complete"
  exit 0
fi

if curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/health"; then
  echo "server already listening on $PORT — attach only"; exit 0
fi
echo "════════════════════════════════════════════════════"
echo "  Syntheniq starting on http://0.0.0.0:$PORT"
echo "  data dir  : $SYNTHENIQ_DATA"
echo "  In GitHub Codespaces, port $PORT is forwarded as HTTPS —"
echo "  open it in the Codespaces 'Ports' view (or on your iPhone)."
echo "════════════════════════════════════════════════════"
exec node apps/api/dist/server.js
