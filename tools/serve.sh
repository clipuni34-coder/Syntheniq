#!/usr/bin/env bash
# Syntheniq one-command launch: self-heals the sandbox toolchain (after any
# restore/reset that wipes binaries), builds if needed, then starts the API.
set -euo pipefail

TOOLS=/home/user/tools
REPO=/home/user/Syntheniq
NODE22=$TOOLS/node-v22.14.0-linux-x64/bin
PASSCODE="${SYNTHENIQ_PASSWORD:-syntheniq-2026}"

echo "==> heal: node 22"
if [ ! -x "$NODE22/node" ]; then
  (cd "$TOOLS" && tar -xJf node22.tar.xz 2>/dev/null || true)
fi
[ -x "$NODE22/node" ] || { echo "FATAL: node22 missing and no tarball"; exit 1; }
export PATH="$NODE22:$PATH"
"$NODE22/node" --version

echo "==> heal: static ffmpeg (drawtext build)"
mkdir -p "$TOOLS/ffmpeg-static"
if ! "$TOOLS/ffmpeg-static/ffmpeg" -hide_banner -filters 2>/dev/null | grep -q drawtext; then
  if [ -x "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg" ]; then
    cp "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg" "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffprobe" "$TOOLS/ffmpeg-static/" 2>/dev/null || true
  fi
  if ! "$TOOLS/ffmpeg-static/ffmpeg" -hide_banner -filters 2>/dev/null | grep -q drawtext; then
    (cd "$TOOLS" && tar -xf btb.tar.xz 2>/dev/null) || true
    if [ -x "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg" ]; then
      cp "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg" "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffprobe" "$TOOLS/ffmpeg-static/"
    fi
  fi
  # last resort: johnvansickle build from local tarball (no drawtext — thumbnails degrade)
  if ! [ -x "$TOOLS/ffmpeg-static/ffmpeg" ]; then
    (cd "$TOOLS" && tar -xf ff.tar.xz 2>/dev/null) || true
    if [ -x "$TOOLS/ffmpeg-7.0.2-amd64-static/ffmpeg" ]; then
      cp "$TOOLS/ffmpeg-7.0.2-amd64-static/ffmpeg" "$TOOLS/ffmpeg-7.0.2-amd64-static/ffprobe" "$TOOLS/ffmpeg-static/" 2>/dev/null || true
    fi
  fi
fi
export PATH="$TOOLS/ffmpeg-static:$PATH"
"$TOOLS/ffmpeg-static/ffprobe" -version | head -1

echo "==> heal: chrome shared libs"
LIBS=$TOOLS/chrome-libs/libs
if [ ! -d "$LIBS" ] || [ -z "$(ls -A "$LIBS" 2>/dev/null)" ]; then
  mkdir -p "$TOOLS/chrome-libs/extract" "$LIBS"
  for d in "$TOOLS"/chrome-libs/*.deb; do dpkg-deb -x "$d" "$TOOLS/chrome-libs/extract"; done
  find "$TOOLS/chrome-libs/extract" -name "*.so*" -exec cp -a {} "$LIBS"/ \; 2>/dev/null || true
fi

echo "==> heal: faster-whisper + edge-tts (model downloads lazily on first transcribe)"
python3 -c "import faster_whisper" 2>/dev/null || pip3 install --user -q faster-whisper
python3 -c "import edge_tts" 2>/dev/null || pip3 install --user -q edge-tts

echo "==> restore session work (idempotent — re-writes new files, re-applies patches)"
(cd "$REPO" && \
  python3 tools/write-session-files.py >/dev/null && \
  python3 tools/write-session-tests.py >/dev/null && \
  python3 tools/reapply1.py >/dev/null && \
  python3 tools/reapply2.py >/dev/null && \
  python3 tools/reapply3.py >/dev/null && \
  python3 tools/reapply4.py >/dev/null && \
  python3 tools/reapply5.py >/dev/null && \
  python3 tools/reapply6.py >/dev/null)

echo "==> deps + build (if missing)"
if [ ! -d "$REPO/node_modules" ]; then
  (cd "$REPO" && npm install --no-audit --no-fund >/dev/null)
fi
if [ ! -f "$REPO/apps/api/dist/server.js" ]; then
  (cd "$REPO" && npm run build:api >/dev/null)
fi
if [ ! -f "$REPO/apps/web/out/index.html" ]; then
  (cd "$REPO" && npm run build:web >/dev/null)
fi
export PATH="$NODE22:$TOOLS/ffmpeg-static:$PATH"

echo "==> git (re-init if wiped)"
if [ ! -d "$REPO/.git" ]; then
  (cd "$REPO" && git init -q -b dev/finish-pipeline 2>/dev/null; git add -A; git -c user.name=Syntheniq -c user.email=syntheniq@local commit -qm "restore after reset")
fi

if [ "${1:-}" = "--heal-only" ]; then
  echo "HEAL OK (server not started)"
  exit 0
fi

echo "==> start server (port 8787)"
cd "$REPO/apps/api"
exec env NODE_ENV=production PORT=8787 SYNTHENIQ_DATA="$PWD/data" \
  SYNTHENIQ_PASSWORD="$PASSCODE" \
  WEB_OUT_DIR="$REPO/apps/web/out" \
  "$NODE22/node" dist/server.js
