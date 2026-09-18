#!/usr/bin/env bash
# crash-resume E2E: the headline acceptance criterion, proven on the current build.
# 1. fresh project + upload
# 2. kill -9 the server mid-render
# 3. restart server -> startup reconcile must mark job 'interrupted'
# 4. POST /retry -> must resume from persisted stages (no rework)
# 5. job must complete; downloads must work
set -u
API=http://127.0.0.1:8787
JAR=/tmp/sq-crash.jar
SRVLOG=/tmp/sq-crash-server.log
FAIL=0

step() { echo; echo "═══ $1"; }
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; FAIL=1; }

step "1. auth + fresh project + upload"
curl -s -c $JAR -m 10 -X POST -H 'content-type: application/json' -d '{"password":"syntheniq-2026"}' $API/v1/auth > /dev/null
PID=$(curl -s -b $JAR -m 10 -X POST -H 'content-type: application/json' -d '{}' $API/v1/projects | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -b $JAR -m 180 -X POST -F "file=@/home/user/Syntheniq/tools/syntheniq-test-source.mp4;type=video/mp4" "$API/v1/projects/$PID/upload" > /dev/null
echo "  job: $PID"

step "2. wait for render stage, then kill -9"
SRVPID=""
for i in $(seq 1 60); do
  STAGE=$(curl -s -b $JAR -m 10 "$API/v1/projects/$PID" | python3 -c "import sys,json;print(json.load(sys.stdin).get('stage',''))" 2>/dev/null)
  SRVPID=$(pgrep -f "node dist/server.js" | grep -v $$ | head -1)
  if [ "$STAGE" = "render" ]; then
    echo "  reached render after ~$((i*10))s (server pid $SRVPID)"; break
  fi
  sleep 10
done
[ "$STAGE" = "render" ] && ok "job reached render" || { bad "never reached render (stage=$STAGE)"; exit 1; }
# let the render actually start (chrome up)
sleep 20
kill -9 $SRVPID 2>/dev/null
sleep 3
pgrep -f "node dist/server.js" | grep -v $$ > /dev/null && bad "server still alive after kill -9" || ok "server killed mid-render"
# kill any orphaned render/chrome children from the dead server
pkill -9 -f "hyperframes render" 2>/dev/null
sleep 1

step "3. restart server -> reconcile must stamp interrupted"
cd /home/user/Syntheniq/apps/api
( set -a && . /home/user/syntheniq.env && set +a && \
  env PATH=/home/user/tools/ffmpeg-static:/home/user/tools/node-v22.14.0-linux-x64/bin:$PATH \
      NODE_ENV=production PORT=8787 SYNTHENIQ_DATA=$PWD/data SYNTHENIQ_PASSWORD=syntheniq-2026 \
      WEB_OUT_DIR=/home/user/Syntheniq/apps/web/out \
      /home/user/tools/node-v22.14.0-linux-x64/bin/node dist/server.js > $SRVLOG 2>&1 & )
for i in $(seq 1 30); do curl -s -m 3 -o /dev/null $API/v1/health && break; sleep 2; done
grep -q "marked interrupted" $SRVLOG && ok "startup reconcile stamped '$PID' interrupted" || bad "no reconcile log line"
curl -s -c $JAR -m 10 -X POST -H 'content-type: application/json' -d '{"password":"syntheniq-2026"}' $API/v1/auth > /dev/null
ST=$(curl -s -b $JAR -m 10 "$API/v1/projects/$PID" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))")
[ "$ST" = "interrupted" ] && ok "job status = interrupted" || bad "status = $ST"

step "4. POST /retry -> resume from persisted stages"
curl -s -b $JAR -m 15 -X POST -H 'content-type: application/json' -d '{}' "$API/v1/projects/$PID/retry" | grep -q '"running"' && ok "retry accepted" || bad "retry rejected"
sleep 25
RESUME=$(grep -c "reusing persisted" $SRVLOG || true)
[ "$RESUME" -ge 3 ] && ok "resumed with $RESUME persisted-stage reuses" || bad "only $RESUME reuse lines"

step "5. wait for completion + verify"
DONE=""
for i in $(seq 1 40); do
  ST=$(curl -s -b $JAR -m 10 "$API/v1/projects/$PID" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))" 2>/dev/null)
  [ "$ST" = "done" ] && { DONE=yes; break; }
  [ "$ST" = "error" ] && break
  sleep 15
done
[ "$DONE" = "yes" ] && ok "job completed after crash-resume" || bad "job did not complete (status=$ST)"
N=$(ls /home/user/Syntheniq/apps/api/data/$PID/files/*.mp4 2>/dev/null | wc -l)
[ "$N" -ge 1 ] && ok "$N mp4(s) on disk" || bad "no mp4s"
curl -s -b $JAR -m 40 -o /tmp/crash-clip.mp4 -w "  " "$API/v1/projects/$PID/files/clip-1.mp4" | grep -q "HTTP" && \
  curl -s -b $JAR -m 40 -o /dev/null -w "download clip-1: HTTP %{http_code}\n" "$API/v1/projects/$PID/files/clip-1.mp4"
/home/user/tools/ffmpeg-static/ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/crash-clip.mp4 2>/dev/null | xargs echo "  clip-1 duration:"

echo
[ $FAIL -eq 0 ] && echo "CRASH-RESUME E2E: ALL PASS ($PID)" || echo "CRASH-RESUME E2E: FAILURES ($PID)"
exit $FAIL
