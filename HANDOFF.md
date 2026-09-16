# SYNTHENIQ — HANDOFF FOR THE NEXT AGENT

Read this first, then `docs/SESSION_STATE.md` (operational recovery recipe).

## TL;DR

- **Syntheniq is COMPLETE and was demonstrated end-to-end 10+ times** (upload → transcribe → analyze → clip selection → retention plan → HyperFrames+FFmpeg render → technical + editorial QC → auto-repair → downloadable 9:16 MP4s + posting package + A/B hook variant MP4s).
- The work was done by a previous agent in this Arena workspace. **All of it is encoded in this repo** — you do not need that agent's chat history.
- **CRITICAL ENVIRONMENT FACT:** this sandbox gets **wiped repeatedly** (10 times in one session). Wipes delete: `.git`, `node_modules`, `dist`, `apps/web/out`, installed toolchains (`/home/user/tools/node-v22*`, `ffmpeg-static`, `chrome-libs/libs`), `apps/api/data`, `/tmp`, pip `--user` packages. Wipes do **NOT** delete: this repo's source files (they get reverted to the ORIGINAL snapshot) and the session files in `tools/` (the `reapply*.py`, `write-session-*.py`, `ui-shots.mjs` scripts — they survive).
- After any wipe, the whole project is restored in **~2 minutes** with the scripted recipe below. This has been proven 10 times.

## What was built (all verified)

On top of the original repo (Fastify API + Next.js static web UI):

1. **Motion graphics engine** (`pipeline/graphics.ts`) — stat / list / callout panels, GSAP-animated, frame-verified.
2. **Editorial QC** (`pipeline/qc-editorial.ts`) — motion-cue density, dead-gap, payoff-placement, hook-timing checks.
3. **AI provider router** (`ai/router.ts`) — Gemini → Grok → OpenAI → heuristic fallback, 90s cooldown, no key = deterministic heuristic mode.
4. **Packaging** — complete-sentence titles, derived angle, clean content-derived hashtags, CTA, rationale; full per-clip meta JSON + per-platform captions.
5. **A/B hook variants** — heuristic proposes a payoff-led variant; pipeline renders it as `<id>_v1.mp4` + thumb; on-demand variant endpoint also exists (`POST /v1/projects/:id/clips/:clipId/variants`); UI shows a VARIANTS section with download buttons.
6. **Render/QC hardening** — frozen-composition guard (6× signalstats), audio-silence guard (volumedetect), retry endpoint accepts `done` jobs (re-process).
7. **UI fixes** (reapply6) — deep links (`/project` → `project.html`), `done()` marks all stages done (no forever-spinners), whisper carry-over hyphen tokens stripped ("-by"→"by").
8. **Test harnesses** — `test/failover-check.mjs` (expect **9/9**) and `test/regression.mjs` (expect **22/22**, 4 synthetic cases through the real prep→compose→render→qc path, ~4 min).
9. **UI screenshot tool** — `tools/ui-shots.mjs` (headless Chrome via CDP; passcode + project page).
10. **UI** (original repo, verified working) — passcode screen, project page with pipeline stages, clip cards (player + Download MP4 + Thumbnail), meta grid (TikTok/IG/YouTube captions, hashtags, CTA, source range, "Why this edit"), VARIANTS section.

## RESTORE RECIPE — ONE COMMAND (proven after every wipe)

```bash
bash /home/user/Syntheniq/tools/serve.sh            # full restore + starts the server on :8787
bash /home/user/Syntheniq/tools/serve.sh --heal-only  # full restore WITHOUT starting the server
```

This single script (~60s) does everything: heals the toolchain (node22, ffmpeg-drawtext,
chrome libs, faster-whisper, edge-tts), **restores all session work** (writers + reapply1→6),
installs deps, builds API + web, and re-inits git. Idempotent — safe to run any time.
If `serve.sh` itself was wiped but the `tools/reapply*.py` + `write-session-*.py` scripts
survive, use the manual recipe below.

## MANUAL RESTORE RECIPE (fallback)

```bash
cd /home/user/tools   # if /home/user/tools doesn't exist: mkdir -p and download:
#   node:  https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz  → rename node22.tar.xz
#   ffmpeg: https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz → btb.tar.xz  (MUST be the BtbN GPL build — needs drawtext)
#   chrome libs: the .deb files under /home/user/tools/chrome-libs/ (they survive wipes; if missing, grab libnss3/libatk/libasound etc. for headless chrome)

# 1) toolchain (~30s)
tar -xJf node22.tar.xz
tar -xf btb.tar.xz
mkdir -p ffmpeg-static && cp ffmpeg-master-latest-linux64-gpl/bin/ffmpeg ffmpeg-master-latest-linux64-gpl/bin/ffprobe ffmpeg-static/
cd chrome-libs && rm -rf extract libs && mkdir -p extract libs && for d in *.deb; do dpkg-deb -x "$d" extract; done && find extract -name "*.so*" -exec cp -a {} libs/ \;
cd /home/user/Syntheniq

export PATH=/home/user/tools/node-v22.14.0-linux-x64/bin:$PATH
npm install --no-audit --no-fund
pip3 install --user faster-whisper edge-tts
git init -b dev/finish-pipeline 2>/dev/null; git add -A; git -c user.name=Syntheniq -c user.email=syntheniq@local commit -qm "snapshot"

# 2) restore ALL session work (ORDER MATTERS: writers, then 1→6) (~5s)
python3 tools/write-session-files.py && python3 tools/write-session-tests.py
python3 tools/reapply1.py && python3 tools/reapply2.py && python3 tools/reapply3.py && python3 tools/reapply4.py && python3 tools/reapply5.py && python3 tools/reapply6.py

# 3) build (~30s)
node_modules/.bin/tsc -p apps/api/tsconfig.json        # must be CLEAN
npm run build:web                                        # → apps/web/out

# 4) run the server
export PATH=/home/user/tools/ffmpeg-static:$PATH
cd apps/api && NODE_ENV=production PORT=8787 SYNTHENIQ_DATA=$PWD/data SYNTHENIQ_PASSWORD=syntheniq-2026 WEB_OUT_DIR=/home/user/Syntheniq/apps/web/out node dist/server.js

# 5) verify
node test/failover-check.mjs     # expect: 9/9
node test/regression.mjs         # expect: 22/22 (run with ffmpeg-static on PATH)
```

## End-to-end test (full proof, ~25 min on CPU-only box)

```bash
# auth + project + upload (upload is MULTIPART, field name "file"; create project needs -d '{}')
curl -c /tmp/sq.jar -X POST http://127.0.0.1:8787/v1/auth -H 'content-type: application/json' -d '{"password":"syntheniq-2026"}'
PID=$(curl -s -b /tmp/sq.jar -X POST http://127.0.0.1:8787/v1/projects -H 'content-type: application/json' -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -b /tmp/sq.jar -X POST http://127.0.0.1:8787/v1/projects/$PID/upload -F "file=@<source.mp4>;type=video/mp4"
# poll:  curl -s -b /tmp/sq.jar http://127.0.0.1:8787/v1/projects/$PID
# done → apps/api/data/$PID/files/ has clip-N.mp4, clip-N_v1.mp4 (variant), thumbs, *_meta.json
# UI check: node tools/ui-shots.mjs $PID   (screenshots in /tmp/ui-*.png)
```

**Test source video** — if missing, regenerate (~1 min): write ~280 words of a monologue about video editing/retention (mention: workflow, mistake, retention, first sentence, captions, "doubled my watch time", "two things"), then:
`python3 -m edge_tts --voice en-US-GuyNeural -f monologue.txt --write-media vo.mp3` and mux:
`ffmpeg -f lavfi -i testsrc2=size=1080x1920:rate=30 -i vo.mp3 -c:v libx264 -preset veryfast -crf 23 -c:a aac -shortest -pix_fmt yuv420p source.mp4`

## Key file map

- `apps/api/src/pipeline/` — index.ts (orchestration), transcribe.ts, plan.ts, prep.ts, compose.ts (composition generator), motion.ts, graphics.ts (session), qc-editorial.ts (session), render.ts (render+QC), package.ts, media.ts, variant.ts (on-demand variants)
- `apps/api/src/ai/` — router.ts (session), heuristic.ts (offline brain: analysis+plan+packaging+variant proposal), gemini.ts, grok.ts, openai.ts, transcribe-gemini.ts
- `apps/api/src/server.ts` — Fastify: /v1/auth, /v1/projects(+/:id, /upload, /retry, /files/:name, clip variants), static web + deep links
- `apps/api/src/jobs.ts` — job state machine, stage tracking, persistence
- `apps/web/` — Next.js static export (app/page.tsx = home+passcode, app/project/page.tsx = project view)
- `tools/` — **reapply1-6.py + write-session-*.py = the complete session work in script form**; serve.sh (one-command launch); ui-shots.mjs
- `docs/SESSION_STATE.md` — operational state + recovery recipe (keep updated!)

## Pitfalls (learned the hard way — do not repeat)

1. **Never judge a render by exit code.** Frame-check outputs (the regression harness + qcClip do this).
2. **reapply scripts must run in order 1→6** (anchors depend on earlier patches). They are idempotent — re-running is safe.
3. `reapply3.py` line ~157 has a deliberate double-backslash (`'].join('\\n      ');`) — do not "fix" it.
4. Sandbox path quirk: executing via `../`-relative paths from a subdirectory can fail ENOENT — use root-relative or absolute paths (e.g. run tsc from repo root: `node_modules/.bin/tsc -p apps/api/tsconfig.json`).
5. Upload endpoint is multipart field `file`; plain `content-type: video/mp4` bodies → 415.
6. When restarting the server: the old node *child* holds the port (EADDRINUSE); verify with `curl` before starting a new one.
7. HyperFrames: no `color` CSS prop; sub-composition template contract; GSAP timelines via `window.__timelines`; package.json required in comp dir.
8. Chrome headless needs `LD_LIBRARY_PATH=/home/user/tools/chrome-libs/libs` (render.ts's toolEnv does this for renders).
9. The BtbN GPL ffmpeg build is REQUIRED (drawtext). The Johnvansickle 7.0.2 build in the repo lacks drawtext — never use it for this project.
10. Rendering is CPU-only here (swiftshader) — a full E2E with a variant takes ~25 min. Don't panic; check `job.logs` before assuming a hang.

## Pending (need the user)

1. **GitHub PAT** → push `dev/finish-pipeline` to public repo `clipuni34-coder/Syntheniq` (base repo HEAD was main @ 200f4a0). No force-push, no resets, incremental commits only.
2. **AI API key** (Gemini/OpenAI/Grok via `AI_PROVIDER`/`AI_MODEL`/key env) → activates the AI editorial path (heuristic path works fully without it).

## Git

Wipes delete `.git`. After restore: `git init -b dev/finish-pipeline` + commit. Proven good commit on the old history: `d85d1f7` (full chain proven). Nothing has ever been pushed (PAT pending).
