# SESSION_STATE — recovery recipe (updated 2026-09-16, post reset #8)

## If the sandbox was reset again
1. `bash tools/serve.sh --heal-only`   (heals node22, ffmpeg-static+drawtext, chrome-libs, whisper, edge-tts,
   **restores session work (writers + reapply1→6)**, deps, dist, web out — ONE COMMAND, ~60s, proven after reset #13)
2. **Restore NEW source files** (resets delete files not in the original snapshot):
   `python3 tools/write-session-files.py && python3 tools/write-session-tests.py`
   (graphics.ts, qc-editorial.ts, ai/router.ts, test/failover-check.mjs, test/regression.mjs)
3. **Re-apply patches to tracked files** (idempotent; skips if already applied; ORDER MATTERS 1→6):
   `python3 tools/reapply1.py && python3 tools/reapply2.py && python3 tools/reapply3.py && python3 tools/reapply4.py && python3 tools/reapply5.py && python3 tools/reapply6.py`
   (reapply6 = UI fixes: deep links /project→project.html, done() marks all stages done,
   whisper carry-over hyphen tokens "-by"→"by"; reapply6's jobs.ts anchor needs reapply1 first)
4. Rebuild: `PATH=/home/user/tools/node-v22.14.0-linux-x64/bin:$PATH npm run build:api && npm run build:web`
5. Start server (start_process):
   `export PATH=/home/user/tools/ffmpeg-static:/home/user/tools/node-v22.14.0-linux-x64/bin:$PATH; cd /home/user/Syntheniq/apps/api && NODE_ENV=production PORT=8787 SYNTHENIQ_DATA=$PWD/data SYNTHENIQ_PASSWORD=syntheniq-2026 WEB_OUT_DIR=/home/user/Syntheniq/apps/web/out exec /home/user/tools/node-v22.14.0-linux-x64/bin/node dist/server.js`
6. Re-auth: `curl -c /tmp/sq.jar -X POST http://127.0.0.1:8787/v1/auth -H 'content-type: application/json' -d '{"password":"syntheniq-2026"}'`
7. **Manual fallback** (if serve.sh or toolchain tarballs are also wiped — proven post reset #7):
   - node22: `cd /home/user/tools && tar -xJf node22.tar.xz` (else re-download 22.x linux-x64)
   - ffmpeg: BtbN gpl build (HAS drawtext; Johnvansickle build lacks it) → bin/ to ffmpeg-static/
   - chrome-libs: `cd chrome-libs && for d in *.deb; do dpkg-deb -x "$d" extract; done && find extract -name "*.so*" -exec cp -a {} libs/ \;`
   - `npm install --no-audit --no-fund` (root) · `pip3 install --user faster-whisper`
   - `git init -b dev/finish-pipeline` + snapshot commit, then steps 2–6
   - test source video (also wiped): regenerate with `python3 -m edge-tts --voice en-US-GuyNeural
     -f /tmp/monologue.txt --write-media vo.mp3` + ffmpeg testsrc2 1080x1920@30 mux (monologue
     text is in the transcript of any old E2E job, or rewrite ~280 words on editing/retention)
- **Upload API**: `POST /v1/projects/:id/upload` is MULTIPART field `file` (plain
  content-type:video/mp4 body → 415). Create project needs `-d '{}'`.
- **Sandbox path quirk**: running binaries via `../`-relative paths from a subdir can fail
  with ENOENT even when the file exists — use root-relative or absolute paths.

## Tests (after any rebuild)
- `node apps/api/test/failover-check.mjs`  → expect 9/9
- `node apps/api/test/openai-client.mjs`   → expect 14/14 (mocked fetch; locks in the live OpenAI
  API contract: json_object, lowercase-json input guard, per-model temperature auto-learning)
- `node apps/api/test/regression.mjs`      → expect 22/22 (cases A-D, real renders ~3.5 min)

- CRASH-RESUME E2E (c7bdd1cd): server kill -9'd mid-render → persisted state left 'running'.
  NEW startup reconcile (server.ts, before listen): orphaned running/cancelling jobs → 'interrupted'
  with clear error; UI shows "Paused — resume ready"; POST /retry accepted → resumed with
  audio/transcribe/analyze/plan/prep ALL "reusing persisted (resume)", render restarted.
  BUGS FIXED: (1) hydrateJob's crash guard misfired on fresh uploads (legit 'running' job got
  stamped with a ghost error) — guard removed, crash handling centralized at startup;
  (2) a silently-failed build (npm script run from wrong cwd, grep masked exit code) shipped a
  stale dist — build now verified by grep of the new symbol in dist.
  Watchdog fired LIVE again: hung chrome render SIGKILLed at 40 min, auto-retry started (2nd
  time proven; 2nd attempt hung again on this loaded box — surfaces as clean error after retry).
- E2E ded3ff0b DONE (540s) — full run on the ONE-COMMAND-restore server (serve.sh full mode
  auto-loads /home/user/syntheniq.env → OpenAI live without any manual env); 2 clips + 2 auto
  variants. **On-demand variant endpoint E2E-verified**: POST /v1/projects/:id/clips/:cid/variants
  with custom hookText "Nobody finishes your videos because of ONE habit" → 400 without hook,
  200 with → clip-1_var1.mp4 + thumb rendered (<60s), downloadable via /files/.
  **Secrets sweep of public repo: clean** (no API keys/PATs in any tracked file).
- E2E 027227bf DONE (1903s) — **LIVE-SERVER run on the deployed build**: all stages openai/gpt-5.6-luna
  (video 22s, analyze 30s, plan 147s, package 8s); GPT chose 1 clip (full 50s source → 41.4s edit)
  with rationale shown in UI; QC 1/1; HTTP download endpoints verified (MP4/thumb/meta all 200)
- RECOVERY HARDENING (post reset #18): serve.sh now (a) auto-downloads BtbN gpl ffmpeg when drawtext
  build + tarball are gone (tested from fully-clean state, 7s), (b) fixes pipefail SIGPIPE false
  negative in drawtext check, (c) stale-dist guard: rebuilds when any src file is newer than build
  output (caught a live incident: reset rolled tree back → heal built stale dist → server ran the
  pre-fix OpenAI client). reapply1/2/4 got version-drift guards (committed source evolved past the
  original anchors: jobs.ts stage loop, render.ts watchdog spawn, 2-arg heuristicPackage).

## UI visually verified (2026-09-17)
- All 5 screens checked from real screenshots (docs/ui-*.png): passcode, authed home/upload
  (Drop-a-video card, 512MB MP4/MOV), project pipeline view, clip cards (incl. GPT rationale
  block above clips), posting package (per-platform captions + Copy).
- All 4 screens checked from real screenshots (docs/ui-*.png): passcode screen, project pipeline
  view (10 stages + provider badges), clip cards (player, AI title, Download MP4/Thumbnail,
  per-platform caption cards + Copy). No rendering defects found.
- All three suites re-run green post reset #17: 9/9 + 14/14 + 22/22.

## Current good state (2026-09-16, post reset #8 — full chain proven again)
- RESET #8 recovered from scratch in ~15 min: writers + reapply1-6 + builds + E2E + 31/31 tests
  (the reapply/writer/ui-shots files SURVIVE resets — only tracked source, .git, node_modules,
  dist, out, toolchain bins, data, /tmp, pip-user pkgs are wiped)
- E2E f3f2ac92 DONE (1560s, swiftshader box): 1 clip + variant clip-1_v1.mp4, all 10 stages
  'done' (verifies the jobs.ts fix live in a fresh run), clean meta (no hyphen tokens):
  title "I started highlighting the important words and changing the style at the key moments."
- regression harness hardening (sourceValid ffprobe check) now BAKED INTO
  write-session-tests.py so it survives future resets
- UI VERIFIED via headless-Chrome CDP screenshots (docs/ui-*.png; script tools/ui-shots.mjs):
  passcode screen, project deep link, all 10 pipeline stages green, clip card (player,
  Download MP4, Thumbnail), meta grid (TikTok/IG/YouTube captions, hashtags, CTA, source
  range, "Why this edit"), VARIANTS section with hook + variant-MP4 download button.
- 3 real bugs found + fixed this turn (encoded in reapply6.py, proven on a fresh tree):
  1. deep link /project served index.html (home) — server now resolves <path>.html
  2. 5 pipeline stages stuck 'running' in a DONE job (spinner forever) — Job.done() now
     marks every stage done
  3. whisper carry-over hyphen tokens ("-by", "-word") leaked into captions/meta —
     transcribe now strips leading hyphens (verified on real audio: "word by word")
- reapply chain is now 6 scripts; recovery from a full reset = toolchain + 2 file-writers
  + reapply1-6 + builds (proven end-to-end this session; manual recipe below if serve.sh
  itself is wiped)
- E2E f336d364 DONE (1577s, slow swiftshader box): 1 clip 18.6s + variant clip-1_v1.mp4,
  1080x1920@30fps, QC 1/1, meta (title/angle/tags/CTA/captions/rationale) + variant in UI
- regression harness hardened: makeSource() ffprobe-validates cached synthetic sources
  (a truncated src60.mp4 in .cache caused a false case-B failure after reset #7)
- E2E 3ac66526 DONE (512s) — **OPENAI RUN**: video/analyze/plan/package all via openai/gpt-5.6-luna
  (gpt-5.6-terra = no credits on this key). GPT: 2 clips, hooks "40 Views After Six Hours" /
  "Your Captions Are Losing Viewers", archs open-loop + question-investigation, energy-matched music;
  QC 2/2, 1080x1920@30+audio. openai.ts fixes (live-verified): json_object not json,
  temperature rejected on gpt-5.6-* (auto-learn + retry), literal lowercase "json" required in input
- E2E d35d90c4 DONE (654s) — **FULL AI RUN**: video/analyze/plan/package all via
  gemini-3.5-flash-lite (key wired server-side). Gemini hook "I spent 6 hours for 40 views",
  arch consequence-first-explanation, stat graphic at the payoff, variant angle
  "Stop starting your videos with intros"; QC 1/1, 1080x1920@30+audio
- E2E 54ca9028 DONE (600s): 2 clips + 2 VARIANTS (payoff-led hooks), frame-verified A/B hooks
  (main "SO THREE MONTHS AGO I MADE" curiosity vs variant "IT SOUNDS SIMPLE BUT IT MORE THAN
  DOUBLED MY WATCH TIME" payoff — same edit, different hook); stat graphic "2x" at 14.28s
- reapply chain is now 5 scripts (5 = variant chain + audio-silence QC); recovery from a
  full reset = serve.sh --heal-only + 2 file-writers + reapply1-5 + builds (proven end-to-end)
- E2E f6f2e98a DONE twice (fresh 328s + re-run of a done job 340s):
  - clip-1 (24.8s) + clip-2 (18.0s), 1080x1920@30fps, audio, full decode, QC 2/2, thumbs + meta
  - stat graphic "2x MULTIPLIER" frame-verified at the "doubled my watch time" moment
  - packaging: complete-sentence titles, derived angle (Mistake→Fix / List-how-to), clean hashtags
  - keyphrases now content words (fix, retention, workflow, captions…) — was (time, completely, cannot)
- retry endpoint now accepts done jobs (re-process with current pipeline)
- qcClip includes a frozen-composition guard (black frames + static picture) — catches §27 snapshot failures
- git head on dev/finish-pipeline; GitHub push still needs a PAT

## Known limitations (accepted)
- Heuristic-only mode (no AI keys): deterministic; AI path activates automatically when a key is set.
- Cross-clip enumeration (a 2-point list split across two clips) is intentionally not synthesized.
