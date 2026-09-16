#!/usr/bin/env bash
# Syntheniq sandbox toolchain bootstrap (idempotent, no root required).
# Recovers everything a sandbox environment reset can wipe:
#   node 22, npm deps, static ffmpeg (drawtext), faster-whisper + model,
#   Chrome shared libs, git repo, api + web builds.
# Usage: bash tools/bootstrap.sh [--skip-web]
set -euo pipefail

TOOLS=/home/user/tools
REPO=/home/user/Syntheniq
NODE22=$TOOLS/node-v22.14.0-linux-x64/bin
SKIP_WEB=0
[ "${1:-}" = "--skip-web" ] && SKIP_WEB=1

echo "==> 1/7 Node 22"
if [ ! -x "$NODE22/node" ]; then
  (cd "$TOOLS" && tar -xJf node22.tar.xz)
fi
export PATH="$NODE22:$TOOLS/ffmpeg-static:$PATH"
node --version

echo "==> 2/7 npm dependencies"
(cd "$REPO" && npm install --no-audit --no-fund >/dev/null)

echo "==> 3/7 static ffmpeg (with drawtext)"
mkdir -p "$TOOLS/ffmpeg-static"
if ! "$TOOLS/ffmpeg-static/ffmpeg" -hide_banner -filters 2>/dev/null | grep -q drawtext; then
  if [ -x "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg" ]; then
    cp "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg" \
       "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffprobe" "$TOOLS/ffmpeg-static/"
  else
    curl -sL -o "$TOOLS/btb.tar.xz" \
      https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz
    (cd "$TOOLS" && tar -xf btb.tar.xz)
    cp "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg" \
       "$TOOLS/ffmpeg-master-latest-linux64-gpl/bin/ffprobe" "$TOOLS/ffmpeg-static/"
  fi
fi
"$TOOLS/ffmpeg-static/ffprobe" -version | head -1

echo "==> 4/7 faster-whisper + small model"
python3 -c "import faster_whisper" 2>/dev/null || pip3 install --user -q faster-whisper
python3 -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8'); print('whisper model ready')"

echo "==> 5/7 Chrome shared libraries (user-space)"
LIBS=$TOOLS/chrome-libs/libs
if [ ! -d "$LIBS" ] && ls "$TOOLS"/chrome-libs/*.deb >/dev/null 2>&1; then
  mkdir -p "$TOOLS/chrome-libs/extract" "$LIBS"
  for d in "$TOOLS"/chrome-libs/*.deb; do dpkg-deb -x "$d" "$TOOLS/chrome-libs/extract"; done
  find "$TOOLS/chrome-libs/extract" -name "*.so*" -exec cp -a {} "$LIBS"/ \;
fi
CH=$(find /home/user/.cache/hyperframes -name "chrome-headless-shell" -type f 2>/dev/null | head -1 || true)
if [ -n "$CH" ] && [ -d "$LIBS" ]; then
  MISSING=$(LD_LIBRARY_PATH=$LIBS ldd "$CH" 2>/dev/null | grep -c "not found" || true)
  echo "   chrome missing libs (with user libs): $MISSING"
else
  echo "   (chrome shell or user libs not present yet — hyperframes fetches chrome on first render)"
fi

echo "==> 6/7 git repo"
if [ ! -d "$REPO/.git" ]; then
  (cd "$REPO" && git init -q -b dev/finish-pipeline && git add -A \
    && git -c user.name="Syntheniq" -c user.email="syntheniq@local" \
        commit -q -m "restore: bootstrap re-commit after sandbox reset")
fi
(cd "$REPO" && git log --oneline -1)

echo "==> 7/7 builds"
(cd "$REPO" && npm run build:api)
if [ "$SKIP_WEB" = "0" ]; then
  (cd "$REPO/apps/web" && ../../node_modules/.bin/next build >/dev/null)
  echo "   web out: $REPO/apps/web/out"
fi

echo "BOOTSTRAP OK"
echo "Start server:"
echo "  cd $REPO/apps/api && PATH=$TOOLS/ffmpeg-static:$NODE22:\$PATH \\"
echo "  NODE_ENV=production PORT=8787 SYNTHENIQ_DATA=\$PWD/data \\"
echo "  SYNTHENIQ_PASSWORD='<your passcode>' WEB_OUT_DIR=$REPO/apps/web/out node dist/server.js"
