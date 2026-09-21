#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Syntheniq inbox watcher (Codespaces large-file lane).
#
# Browser uploads through the GitHub port tunnel are capped (~16-24 MB by the
# tunnel's nginx) — but uploading a file into the codespace with VS Code for
# the web (Explorer → Upload…) streams over the editor's own channel with no
# such cap. Drop long source videos into  /workspaces/Syntheniq/inbox/  via
# the Explorer, and this loop automatically creates a project and feeds the
# file through the EXISTING upload API on localhost (no product code change,
# no tunnel involved).
#
# Imported originals are relocated to  inbox/.done/  after a clean handoff.
# ─────────────────────────────────────────────────────────────────────────────
set -u

PORT="${PORT:-3000}"
BASE="http://127.0.0.1:$PORT"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INBOX="${SYNTHENIQ_INBOX:-/workspaces/Syntheniq/inbox}"
[ -d "$INBOX" ] || INBOX="$ROOT/inbox"
PASS="${SYNTHENIQ_PASSWORD:-syntheniq-2026}"
API_TMP="${TMPDIR:-/tmp}/inbox"
mkdir -p "$INBOX/.done" "$API_TMP"

echo "[inbox] watching $INBOX (api $BASE)"

while true; do
  # wait until the API itself is up (server may still be booting)
  if ! curl -s -o /dev/null -m 3 "$BASE/health"; then sleep 5; continue; fi
  for f in "$INBOX"/*; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    # only video-ish names; skip anything mid-copy or hidden
    case "$base" in
      .*|*.tmp|*.part|*.crdownload) continue ;;
    esac
    # wait for a stable size (upload finished)
    s1="$(stat -c%s "$f" 2>/dev/null || echo 0)"
    sleep 4
    s2="$(stat -c%s "$f" 2>/dev/null || echo 1)"
    [ "$s1" != "$s2" ] && continue
    [ "$s2" = "0" ] && continue

    stamp="$(date +%s)"
    work="$INBOX/.importing-$stamp.mp4"
    mv "$f" "$work" 2>/dev/null || continue
    echo "[inbox] importing $base ($((s2/1048576)) MB)…"

    JAR="$API_TMP/jar-$stamp"
    curl -s -c "$JAR" -o /dev/null -m 15 -X POST \
      -H 'content-type: application/json' \
      -d "{\"password\":\"$PASS\"}" "$BASE/v1/auth"
    NP="$(curl -s -b "$JAR" -m 15 -X POST -H 'content-type: application/json' -d '{}' \
      "$BASE/v1/projects" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)"
    if [ -z "$NP" ]; then
      echo "[inbox] ERROR: could not create project for $base — leaving file in inbox"
      mv "$work" "$f" 2>/dev/null || true
      continue
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -m 1800 -X POST \
      -F "file=@$work;type=video/mp4" "$BASE/v1/projects/$NP/upload")"
    if [ "$code" = "200" ]; then
      echo "[inbox] $base -> project $NP (processing) ✓"
      mv "$work" "$INBOX/.done/${base%.*}-$stamp.mp4" 2>/dev/null || rm -f "$work"
    else
      echo "[inbox] ERROR: upload of $base returned $code — left for retry"
      mv "$work" "$f" 2>/dev/null || true
    fi
  done
  sleep 4
done
