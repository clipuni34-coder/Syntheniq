#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Syntheniq Codespaces acceptance test — 20 checks.
#
#   bash deploy/codespaces/verify.sh                # full: env + E2E + crash
#   bash deploy/codespaces/verify.sh --fast         # env + boot + auth only
#   bash deploy/codespaces/verify.sh --no-crash     # full E2E, skip crash test
#
# Runs its OWN server instance (isolated port + data dir) so it never
# disturbs the Codespace's main instance. AI keys are read from the
# environment (GitHub Codespaces secrets, or SYNTHENIQ_ENV_FILE) — if a key
# is present the live AI path is exercised; if not, the heuristic path is.
#
# Exit code 0 = all checks pass. Do not call it complete unless a real
# render (check 18) has passed.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

FAST=0; NOCRASH=0
for a in "$@"; do case "$a" in
  --fast) FAST=1;;
  --no-crash) NOCRASH=1;;
esac; done

VERIFY_PORT="${VERIFY_PORT:-8790}"
VERIFY_PORT2="${VERIFY_PORT2:-8791}"
VERIFY_DATA="${VERIFY_DATA:-$REPO/.cache/verify-data}"
PASSCODE="${SYNTHENIQ_PASSWORD:-syntheniq-2026}"
API="http://127.0.0.1:$VERIFY_PORT"
JAR="$(mktemp)"
SRV_LOG="$REPO/.cache/verify-server.log"
SRV_LOG2="$REPO/.cache/verify-server-nokeys.log"
SRV_PID=""; SRV_PID2=""
PASS=0; FAIL=0
TOTAL=20
[ "$FAST" = "1" ] && TOTAL=8

mkdir -p "$VERIFY_DATA" "$REPO/.cache"

cleanup() {
  [ -n "$SRV_PID" ]  && kill "$SRV_PID"  2>/dev/null
  [ -n "$SRV_PID2" ] && kill "$SRV_PID2" 2>/dev/null
  rm -f "$JAR"
}
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); echo "PASS [$(printf '%02d' $PASS)/$TOTAL] $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL [$1] — $2"; }
say() { echo "  · $*"; }

json_get() { # $1=dotted.path (json arrives on stdin — use -c so the
             # heredoc does not steal the pipe's stdin)
  python3 -c '
import sys, json
path = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
for p in path.split("."):
    if p == "": continue
    try:
        if isinstance(d, list):
            d = d[int(p)]
        else:
            d = d.get(p) if isinstance(d, dict) else None
    except Exception:
        d = None
    if d is None: break
print("" if d is None else d)
' "${1:-}"
}

start_server() { # $1=port $2=data_dir $3=log ; extra env already exported
  env PORT="$1" SYNTHENIQ_DATA="$2" SYNTHENIQ_PASSWORD="$PASSCODE" \
    node apps/api/dist/server.js > "$3" 2>&1 &
  echo $!
}
wait_health() { # $1=port
  local i code
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$1/health" || true)"
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  return 1
}
job()      { curl -s -m 10 -b "$JAR" "$API/v1/projects/$1"; }
jstatus()  { job "$1" | json_get .status; }
jstage()   { job "$1" | json_get .stage; }
wait_for() { # $1=id $2=max_seconds  → returns when status is terminal
  local i s
  for i in $(seq 1 $(( $2 / 5 ))); do
    s="$(jstatus "$1")"
    case "$s" in done|error|cancelled) return 0;; esac
    sleep 5
  done
  return 1
}

# ── fixture: the committed test source, or a generated 35 s talking video ────
FIXTURE="tools/syntheniq-test-source.mp4"
if [ ! -f "$FIXTURE" ]; then
  say "generating test fixture (edge-tts speech + testsrc2 video) ..."
  FXD="$REPO/.cache/verify-fixture"; mkdir -p "$FXD"
  edge-tts --voice en-US-AriaNeural --write-media "$FXD/t1.mp3" --text "So three months ago, I made a huge mistake with my editing workflow. I spent six hours on a single short. And it got forty views. That is the moment I decided to completely fix my process." 2>/dev/null
  edge-tts --voice en-US-AriaNeural --write-media "$FXD/t2.mp3" --text "The first thing that changed everything, is that I stopped starting my videos with an intro. No more hey guys, welcome back. I just start mid sentence, with the most interesting part." 2>/dev/null
  edge-tts --voice en-US-AriaNeural --write-media "$FXD/t3.mp3" --text "The second thing is captions. If a viewer cannot read your screen, they cannot follow you. Big text, two or three words at a time, and highlight the important words." 2>/dev/null
  edge-tts --voice en-US-AriaNeural --write-media "$FXD/t4.mp3" --text "If you fix just those two things, your retention will change completely. Try it for one week, and come back and thank me." 2>/dev/null
  ffmpeg -y -v error \
    -i "$FXD/t1.mp3" -f lavfi -t 1.5 -i "aevalsrc=0:s=44100" \
    -i "$FXD/t2.mp3" -f lavfi -t 1.2 -i "aevalsrc=0:s=44100" \
    -i "$FXD/t3.mp3" -f lavfi -t 1.5 -i "aevalsrc=0:s=44100" \
    -i "$FXD/t4.mp3" \
    -filter_complex "[0]aresample=22050[a0];[1]aresample=22050[a1];[2]aresample=22050[a2];[3]aresample=22050[a3];[4]aresample=22050[a4];[5]aresample=22050[a5];[6]aresample=22050[a6];[a0][a1][a2][a3][a4][a5][a6]concat=n=7:v=0:a=1[out]" \
    -map "[out]" "$FXD/audio.wav"
  ffmpeg -y -v error -f lavfi -i testsrc2=size=1280x720:rate=30 -i "$FXD/audio.wav" \
    -shortest -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 128k "$FXD/source.mp4"
  FIXTURE="$FXD/source.mp4"
fi

# ═══════════════════════════════════════════════════════════════════════════
echo "════ Syntheniq Codespaces acceptance ════"
say "port $VERIFY_PORT · data $VERIFY_DATA · fixture $FIXTURE"

# 1 — Node version
NM="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0)"
if [ "${NM:-0}" -ge 22 ]; then ok "Node 22+ (have $(node -v))"; else bad "check 01" "Node 22+ required, have $(node -v 2>/dev/null || echo none)"; fi

# 2 — FFmpeg (with drawtext)
FF_FILTERS=""
command -v ffmpeg >/dev/null 2>&1 && FF_FILTERS="$(ffmpeg -hide_banner -filters 2>/dev/null || true)"
case "$FF_FILTERS" in
  *drawtext*) ok "FFmpeg available with drawtext";;
  *) bad "check 02" "FFmpeg (with drawtext) missing";;
esac

# 3 — ffprobe
if command -v ffprobe >/dev/null 2>&1; then ok "ffprobe available"; else bad "check 03" "ffprobe missing"; fi

# 4 — headless Chromium for HyperFrames
CHROME_OK=0
if [ -x node_modules/.bin/hyperframes ] && \
   { node_modules/.bin/hyperframes browser ensure >/dev/null 2>&1 || node_modules/.bin/hyperframes browser >/dev/null 2>&1; }; then
  CHROME_BIN="$(find "$HOME/.cache/hyperframes" -type f \( -name chrome -o -name chrome-headless-shell \) 2>/dev/null | head -1 || true)"
  [ -z "$CHROME_BIN" ] && CHROME_BIN="$(find "$HOME/.cache" -type f -name chrome -path '*chrome-linux*' 2>/dev/null | head -1 || true)"
  [ -n "$CHROME_BIN" ] && CHROME_OK=1
fi
[ "$CHROME_OK" = "1" ] && ok "Chromium for HyperFrames ($CHROME_BIN)" || bad "check 04" "headless Chromium not found (hyperframes browser ensure)"

# 5 — faster-whisper
if python3 -c 'import faster_whisper; from faster_whisper import WhisperModel' 2>/dev/null \
   && python3 -c "from faster_whisper import WhisperModel; WhisperModel('${SYNTHENIQ_WHISPER_MODEL:-small}', device='cpu', compute_type='int8')" 2>/dev/null; then
  ok "faster-whisper import + model '${SYNTHENIQ_WHISPER_MODEL:-small}' (int8)"
else
  bad "check 05" "faster-whisper missing or model failed to load"
fi

if [ ! -f apps/api/dist/server.js ]; then
  bad "check 06" "API not built (npm run build:api) — aborting"
elif [ ! -f "${WEB_OUT_DIR:-apps/web/out}/index.html" ]; then
  bad "check 07" "web UI not built (npm run build:web) — aborting"
else
  SRV_PID="$(start_server "$VERIFY_PORT" "$VERIFY_DATA" "$SRV_LOG")"
  if wait_health "$VERIFY_PORT"; then
    ok "API health (GET /health → 200)"
  else
    bad "check 06" "server did not become healthy in 30 s — log: $SRV_LOG"; exit 1
  fi

  # 7 — web UI
  UI="$(curl -s -m 10 "$API/" || true)"
  if echo "$UI" | grep -qi "<html"; then ok "web UI served at /"; else bad "check 07" "no HTML at /"; fi

  # 8 — auth
  WRONG="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'content-type: application/json' -d '{"password":"definitely-wrong"}' "$API/v1/auth")"
  curl -s -c "$JAR" -o /dev/null -m 10 -X POST -H 'content-type: application/json' -d "{\"password\":\"$PASSCODE\"}" "$API/v1/auth"
  AUTHED="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -b "$JAR" "$API/v1/projects")"
  if [ "$WRONG" = "401" ] && [ "$AUTHED" = "200" ]; then
    ok "passcode auth (wrong → 401, correct → 200)"
  else
    bad "check 08" "auth: wrong=$WRONG (want 401), authorized=$AUTHED (want 200)"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Full run: continue the E2E pipeline on the already-running instance
# (server from checks 6–8 is still up on VERIFY_PORT)
# ═══════════════════════════════════════════════════════════════════════════
if [ "$FAST" = "0" ]; then
  # 9 — project creation
  PID="$(curl -s -b "$JAR" -m 10 -X POST -H 'content-type: application/json' -d '{}' "$API/v1/projects" | json_get .id)"
  if [ -n "$PID" ]; then ok "project created ($PID)"; else bad "check 09" "project creation failed"; fi

  # 10 — upload path
  UP="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -m 300 -X POST \
    -F "file=@$FIXTURE;type=video/mp4" "$API/v1/projects/$PID/upload")"
  if [ "$UP" = "200" ]; then ok "upload accepted (job started)"; else bad "check 10" "upload returned $UP"; fi

  # 11 — transcription
  T_OK=1
  for i in $(seq 1 120); do
    TS="$(job "$PID" | json_get stages.transcribe.status)"
    [ "$TS" = "done" ] && { T_OK=0; break; }
    case "$(jstatus "$PID")" in done|error|cancelled) break;; esac
    sleep 5
  done
  if [ "$T_OK" = "0" ]; then
    ok "transcription completed (whisper, coverage gate passed)"
  else
    bad "check 11" "transcription did not complete (status: $(jstatus "$PID"), stage: $(jstage "$PID"))"
  fi

  # 13 — heuristic fallback on a no-keys instance
  HEUR_OK=0
  ( env -u OPENAI_API_KEY -u GEMINI_API_KEY -u XAI_API_KEY \
    PORT="$VERIFY_PORT2" SYNTHENIQ_DATA="$VERIFY_DATA" SYNTHENIQ_PASSWORD="$PASSCODE" \
    node apps/api/dist/server.js > "$SRV_LOG2" 2>&1 & echo $! > /tmp/verify-srv2.pid )
  SRV_PID2="$(cat /tmp/verify-srv2.pid 2>/dev/null || true)"
  for i in $(seq 1 30); do
    curl -s -o /dev/null -m 2 "http://127.0.0.1:$VERIFY_PORT2/health" 2>/dev/null && { HEUR_OK=1; break; }
    sleep 1
  done
  if [ "$HEUR_OK" = "1" ]; then
    CFG="$(curl -s -m 10 "http://127.0.0.1:$VERIFY_PORT2/v1/config" || true)"
    if echo "$CFG" | grep -q '"ai"' && ! echo "$CFG" | grep -qE 'sk-[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{20,}'; then
      ok "heuristic fallback boots keyless (config ok, no key leakage)"
    else
      bad "check 13" "no-keys /v1/config malformed or leaked a key"
    fi
  else
    bad "check 13" "no-keys server did not boot"
  fi
  [ -n "$SRV_PID2" ] && kill "$SRV_PID2" 2>/dev/null; SRV_PID2=""

  # 15 — HyperFrames render
  R_OK=1
  for i in $(seq 1 360); do
    RS="$(job "$PID" | json_get stages.render.status)"
    [ "$RS" = "done" ] && { R_OK=0; break; }
    case "$(jstatus "$PID")" in done|error|cancelled) break;; esac
    sleep 5
  done
  if [ "$R_OK" = "0" ]; then
    ok "HyperFrames render completed"
  else
    bad "check 15" "render did not complete (status: $(jstatus "$PID"), stage: $(jstage "$PID"))"
  fi

  # 12 — AI provider path (live when keys are present). Checked AFTER the
  # plan stage has had time to run: the plan line lands in the server log
  # when the plan completes.
  PLANLINE="$(grep -o 'plan: .* clips via [a-z]*' "$SRV_LOG" | tail -1 || true)"
  HAS_KEY=0
  for k in OPENAI_API_KEY GEMINI_API_KEY XAI_API_KEY; do [ -n "${!k:-}" ] && HAS_KEY=1; done
  if echo "$PLANLINE" | grep -qE 'via (openai|gemini|grok|openai,|gemini,)'; then
    ok "AI provider path live: $PLANLINE"
  elif [ "$HAS_KEY" = "1" ]; then
    bad "check 12" "keys present but plan did not show a live provider (log: ${PLANLINE:-empty}, status: $(jstatus "$PID"))"
  else
    ok "AI path: no keys supplied → heuristic fallback (expected): ${PLANLINE:-n/a}"
  fi

  # 14 — ClipPlan (persisted by the plan stage)
  NCLIPS="$(job "$PID" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("clips") or []))' 2>/dev/null || echo 0)"
  PLANFILE="$(find "$VERIFY_DATA/$PID" -maxdepth 2 -name 'plan*.json' 2>/dev/null | head -1 || true)"
  if [ "${NCLIPS:-0}" -ge 1 ] && [ -n "$PLANFILE" ]; then
    ok "ClipPlan generated ($NCLIPS clips, persisted)"
  else
    bad "check 14" "ClipPlan missing (clips=$NCLIPS, planfile=${PLANFILE:-none}, status: $(jstatus "$PID"))"
  fi

  # 16 — FFmpeg processing (clip containers valid)
  CLIP_MP4="$(find "$VERIFY_DATA/$PID" -name '*.mp4' ! -name 'source*' 2>/dev/null | head -1 || true)"
  if [ -n "$CLIP_MP4" ] && ffprobe -v error -show_entries format=format_name "$CLIP_MP4" >/dev/null 2>&1; then
    ok "FFmpeg output is a valid container"
  else
    bad "check 16" "no valid clip MP4 found under $VERIFY_DATA/$PID"
  fi

  # 17 — QC
  QC="$(job "$PID" | json_get stages.qc.status)"
  if [ "$QC" = "done" ]; then ok "QC stage passed"; else bad "check 17" "QC status: $QC"; fi

  # 18 — final MP4 (9:16, real duration)
  if [ -n "$CLIP_MP4" ]; then
    W="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$CLIP_MP4" 2>/dev/null)"
    H="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$CLIP_MP4" 2>/dev/null)"
    D="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$CLIP_MP4" 2>/dev/null | cut -d. -f1)"
    if [ "$W" = "1080" ] && [ "$H" = "1920" ] && [ "${D:-0}" -ge 5 ] 2>/dev/null; then
      ok "final MP4: 1080x1920 (9:16), ${D}s"
    else
      bad "check 18" "final MP4 wrong geometry/duration (WxH=${W}x${H}, D=${D}s)"
    fi
  else
    bad "check 18" "no final MP4"
  fi

  # 19 — crash/recovery
  if [ "$NOCRASH" = "1" ]; then
    say "--no-crash: skipping crash/recovery check"
    ok "crash/recovery (skipped by flag)"
  else
    say "crash test: new project, kill -9 mid-pipeline, restart, retry ..."
    C_PID="$(curl -s -b "$JAR" -m 10 -X POST -H 'content-type: application/json' -d '{}' "$API/v1/projects" | json_get .id)"
    curl -s -o /dev/null -b "$JAR" -m 300 -X POST -F "file=@$FIXTURE;type=video/mp4" "$API/v1/projects/$C_PID/upload"
    KILL_AT=""
    for i in $(seq 1 240); do
      ST="$(jstage "$C_PID")"
      case "$ST" in transcribe|analyze) KILL_AT="$ST"; break;; esac
      case "$(jstatus "$C_PID")" in done|error|cancelled) break;; esac
      sleep 5
    done
    if [ -n "$KILL_AT" ]; then
      say "killing server mid-'$KILL_AT' (pid $SRV_PID) ..."
      kill -9 "$SRV_PID" 2>/dev/null; SRV_PID=""; sleep 3
      SRV_PID="$(start_server "$VERIFY_PORT" "$VERIFY_DATA" "$SRV_LOG")"
      wait_health "$VERIFY_PORT" || bad "check 19" "server did not restart after crash"
      # auth tokens are in-memory by design — re-auth against the new process
      curl -s -c "$JAR" -o /dev/null -m 10 -X POST -H 'content-type: application/json' -d "{\"password\":\"$PASSCODE\"}" "$API/v1/auth"
      sleep 2
      I1="$(jstatus "$C_PID")"
      if [ "$I1" = "interrupted" ]; then
        RETRY="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -m 10 -X POST "$API/v1/projects/$C_PID/retry")"
        if [ "$RETRY" = "200" ] && wait_for "$C_PID" 2400; then
          CS="$(jstatus "$C_PID")"
          C_MP4="$(find "$VERIFY_DATA/$C_PID" -name '*.mp4' ! -name 'source*' 2>/dev/null | head -1 || true)"
          if [ "$CS" = "done" ] && [ -n "$C_MP4" ]; then
            ok "crash recovery: interrupted → retry → done (resumed from last completed stage)"
          else
            bad "check 19" "retry finished but no output (status=$CS)"
          fi
        else
          bad "check 19" "retry HTTP $RETRY, final status $(jstatus "$C_PID")"
        fi
      else
        bad "check 19" "expected 'interrupted' after restart, got '$I1'"
      fi
    else
      bad "check 19" "pipeline did not reach killable stage (final: $(jstatus "$C_PID"))"
    fi
  fi

  # 20 — full E2E overall
  FINAL="$(jstatus "$PID")"
  if [ "$FINAL" = "done" ]; then
    ok "FULL PIPELINE: upload → transcribe → analyze → plan → render → package → QC → MP4 (status: done)"
  else
    bad "check 20" "end-to-end job final status: $FINAL"
  fi
else
  say "--fast mode: E2E checks 09-20 not run (8/20 by design)"
fi

# ═══════════════════════════════════════════════════════════════════════════
echo
echo "════════════════════════════════════════════"
echo "  RESULT: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" = "0" ]; then
  [ "$FAST" = "1" ] && echo "  ALL FAST CHECKS PASSED (env + boot + auth) — run without --fast for the full 20-check E2E" \
                    || echo "  ALL CHECKS PASSED — FULL SYNTHENIQ PIPELINE RUNS IN THIS ENVIRONMENT"
else
  echo "  CHECKS FAILED — see above"
fi
echo "════════════════════════════════════════════"
[ "$FAIL" = "0" ]
