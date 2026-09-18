#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Syntheniq — post-deployment acceptance gates.
# Run on the host after `docker compose up -d`:
#
#   bash deploy/verify.sh
#
# Checks (all must pass before trusting the deployment):
#   1. container healthy (API answers)
#   2. ffmpeg drawtext filter present (captions/thumbnails)
#   3. a browser binary is available to HyperFrames (headless shell cache
#      or distro chromium via HYPERFRAMES_BROWSER_PATH)
#   4. whisper model importable
#   5. all four test suites (66 checks) pass inside the container
#   6. web UI serves
#
# Exit code 0 = deployment accepted; non-zero = gate failed (message printed).
# This script only READS the running system — it changes nothing.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

PORT="${SYNTHENIQ_PORT:-8787}"
PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); printf '  \033[1;32mPASS\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[1;31mFAIL\033[0m %s\n' "$1"; }

echo "── Syntheniq deployment verification ──"

# 1. API health (401 = up + gated; 200 = up ungated)
CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/health" 2>/dev/null || echo 000)
if [ "$CODE" = "401" ] || [ "$CODE" = "200" ]; then
  ok "API healthy (HTTP $CODE)"
else
  bad "API not healthy (HTTP $CODE) — docker compose logs --tail 50"
  echo "Cannot continue without the API."
  exit 1
fi

# 2. drawtext
DT=$(docker compose exec -T syntheniq sh -c "ffmpeg -hide_banner -filters 2>/dev/null" | grep -c drawtext || true)
if [ "${DT:-0}" -ge 1 ]; then ok "ffmpeg drawtext present"; else bad "ffmpeg drawtext MISSING — captions/thumbnails will fail"; fi

# 3. browser for HyperFrames
BR=$(docker compose exec -T syntheniq sh -c '
  if [ -n "${HYPERFRAMES_BROWSER_PATH:-}" ] && [ -x "${HYPERFRAMES_BROWSER_PATH}" ]; then echo env;
  elif ls /root/.cache/hyperframes/chrome/chrome-headless-shell/linux-*/chrome-headless-shell-linux64/chrome-headless-shell >/dev/null 2>&1; then echo cache;
  elif [ -x /usr/bin/chromium ]; then echo chromium;
  else echo none; fi' 2>/dev/null | tail -1)
if [ "$BR" = "env" ] || [ "$BR" = "cache" ] || [ "$BR" = "chromium" ]; then
  ok "render browser available (source: $BR)"
else
  bad "no render browser found — rebuild image (x86: default; ARM: --build-arg INSTALL_CHROMIUM=1)"
fi

# 4. whisper
WH=$(docker compose exec -T syntheniq python3 -c "import faster_whisper; print('ok')" 2>/dev/null | tail -1)
if [ "$WH" = "ok" ]; then ok "faster-whisper importable"; else bad "faster-whisper missing (transcription fallback would fail)"; fi

# 5. test suites inside the container
docker compose exec -T syntheniq sh -c "cd /repo/apps/api && \
  node test/openai-client.mjs && node test/regression.mjs && \
  node test/failover-check.mjs && node test/model-routing.mjs" > /tmp/syn-verify-tests.log 2>&1
if [ $? -eq 0 ]; then
  TAIL=$(grep -E "pass|checks" /tmp/syn-verify-tests.log | tail -4 | sed 's/^/        /')
  ok "test suites (expect 15+22+9+20 checks)"
  echo "$TAIL"
else
  bad "test suites failed — last lines:"
  tail -6 /tmp/syn-verify-tests.log | sed 's/^/        /'
fi

# 6. web UI
WEB=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || echo 000)
if [ "$WEB" = "200" ]; then ok "web UI serves (HTTP 200)"; else bad "web UI not serving (HTTP $WEB)"; fi

echo "────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  echo "RESULT: \033[1;32mACCEPTED\033[0m ($PASS/$PASS gates passed)"
  echo "Now do the live test FROM YOUR IPHONE: upload a real video, watch"
  echo "analyze → plan → render → QC, then download a clip."
  exit 0
else
  echo "RESULT: \033[1;31mREJECTED\033[0m ($FAIL gate(s) failed — see above)"
  exit 1
fi
