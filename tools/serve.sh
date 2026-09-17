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
# NOTE: don't use `ffmpeg -filters | grep -q` here — under `set -o pipefail`,
# grep -q exits early, ffmpeg hits SIGPIPE, and the pipeline reports failure
# even when drawtext is present (false negative → endless re-heal).
has_drawtext() {
  local flist
  flist="$("$TOOLS/ffmpeg-static/ffmpeg" -hide_banner -filters 2>/dev/null || true)"
  case "$flist" in
    *drawtext*) return 0 ;;
    *) return 1 ;;
  esac
}
if ! has_drawtext; then
  if [ -x "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg" ]; then
    cp "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg" "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffprobe" "$TOOLS/ffmpeg-static/" 2>/dev/null || true
  fi
  if ! has_drawtext; then
    # no gpl build locally → fetch the BtbN GPL build (drawtext included)
    if ! [ -f "$TOOLS/btb.tar.xz" ]; then
      echo "    downloading BtbN gpl ffmpeg (drawtext) ..."
      curl -sL --max-time 240 -o "$TOOLS/btb.tar.xz" \
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" || true
    fi
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
if has_drawtext; then
  echo "ffmpeg drawtext: OK"
else
  echo "ffmpeg drawtext: MISSING — thumbnails will fail (manual fix: download BtbN linux64-gpl build and copy bins to $TOOLS/ffmpeg-static/)"
fi

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
  python3 tools/reapply6.py >/dev/null && \
  python3 tools/reapply7.py >/dev/null)

echo "==> deps + build (if missing or stale)"
if [ ! -d "$REPO/node_modules" ]; then
  (cd "$REPO" && npm install --no-audit --no-fund >/dev/null)
fi
# rebuild when ANY source file is newer than the build output (stale-dist guard:
# a reset can roll the tree back, heal builds, then the tree is restored —
# without this check the server would run the pre-restore code)
if [ ! -f "$REPO/apps/api/dist/server.js" ] \
   || [ -n "$(find "$REPO/apps/api/src" -newer "$REPO/apps/api/dist/server.js" -print -quit 2>/dev/null)" ]; then
  (cd "$REPO" && npm run build:api >/dev/null)
fi
if [ ! -f "$REPO/apps/web/out/index.html" ] \
   || [ -n "$(find "$REPO/apps/web" \( -path "$REPO/apps/web/node_modules" -o -path "$REPO/apps/web/out" -o -path "$REPO/apps/web/.next" \) -prune -o -newer "$REPO/apps/web/out/index.html" -print -quit 2>/dev/null)" ]; then
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
# AI config: keys live OUTSIDE the repo (the repo is public). If /home/user/syntheniq.env
# exists (OPENAI_API_KEY / GEMINI_API_KEY / XAI_API_KEY + AI_PROVIDER / AI_MODEL), load it.
AI_ENV=/home/user/syntheniq.env
if [ -f "$AI_ENV" ]; then
  set -a
  . "$AI_ENV"
  set +a
  echo "    AI config loaded from $AI_ENV (provider: ${AI_PROVIDER:-auto}, model: ${AI_MODEL:-defaults})"
else
  echo "    no $AI_ENV — running heuristic (offline AI) mode"
fi
cd "$REPO/apps/api"
exec env NODE_ENV=production PORT=8787 SYNTHENIQ_DATA="$PWD/data" \
  SYNTHENIQ_PASSWORD="$PASSCODE" \
  WEB_OUT_DIR="$REPO/apps/web/out" \
  "$NODE22/node" dist/server.js
