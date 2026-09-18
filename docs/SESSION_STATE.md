# SESSION_STATE — recovery recipe (updated 2026-09-17, post reset #21)

## If the sandbox was reset again
1. `bash tools/serve.sh --heal-only`   (heals node22, ffmpeg-static+drawtext, chrome-libs,
   **chrome-headless-shell install — OFFLINE from tools/152.0.7977.30-chrome-headless-shell-
   linux64.zip (119MB, bundled in tools/, survives resets; icudtl.dat = root cause of the
   render-hang crashes)**, **swap 3GB**, whisper, edge-tts, **restores session work
   (writers + reapply1→8)**, deps, dist, web out — ONE COMMAND, ~60s, **100% offline** —
   proven after resets #21–#28)
2. **Restore NEW source files** (resets delete files not in the original snapshot):
   `python3 tools/write-session-files.py && python3 tools/write-session-tests.py`
   (graphics.ts, qc-editorial.ts, ai/router.ts, test/failover-check.mjs, test/regression.mjs)
3. **Re-apply patches to tracked files** (idempotent; skips if already applied; ORDER MATTERS 1→8):
   `for i in 1 2 3 4 5 6 7 8; do python3 tools/reapply$i.py; done`
   (reapply6 = UI fixes; **reapply8 = the two fixes that postdate reapply1-7: full openai.ts
   (json_object not json, lowercase-json input guard, per-model temperature auto-learning,
   image data-URL comma) + test/openai-client.mjs (15/15) + server.ts startup reconcile
   (crash-consistency) + jobs.ts hydrateJob per-load guard removed**)
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
   - **RESET #20 note**: serve.sh's git re-init leaves NO remote configured and the PAT was in
     /tmp (wiped) — to push: `git remote add origin
     https://x-access-token:<PAT>@github.com/clipuni34-coder/Syntheniq.git` then
     `git push origin dev/finish-pipeline`. Local head: 61c277c (remote was 79bd34b).
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

- **RENDER-HANG ROOT CAUSE (found + fixed, 2026-09-17): chrome-headless-shell's `icudtl.dat`
  (and the .pak/data files) were missing from the extracted install dir, leaving only
  ABOUT/LICENSE/binary. Without icudtl.dat chrome IMMEDIATE_CRASH()s at startup (SIGTRAP,
  si_code=SI_KERNEL — a CHECK failure, NOT seccomp/OOM/missing-lib); puppeteer surfaces this as
  "Failed to launch the browser process: Code: null" and hyperframes then hangs ~forever in
  "Creating capture session" (40-min watchdog ×4 per job). Diagnosis path that worked: strace the
  binary (last syscalls = read TZif → write ICU error → SIGTRAP; the strace line
  `openat(.../icudtl.dat) = -1 ENOENT` is the smoking gun). FIX: `unzip -oq` the cached zip at
  ~/.cache/hyperframes/chrome/chrome-headless-shell/<ver>-...zip into its linux-<ver>/ dir.
  PREVENTION: serve.sh now re-extracts the chrome install automatically when icudtl.dat is missing
  (commit 61c277c). After the fix the SAME c7bdd1cd job completed: pipeline complete in 1182s,
  2 clips + 2 variants, QC 2/2, all 4 MP4s downloadable via /files/ (h264 1080x1920 + aac).
  Note: `timeout N chrome ... | head` masks the exit code (you see head's 0) — check PIPESTATUS
  or run chrome to a file to catch the 133 (128+5=SIGTRAP).
- **RESET #22: SELF-HEAL PROVEN (2026-09-17)**: reset #22 rolled the tree back past the
  reapply8 fixes again (openai.ts/server.ts/jobs.ts stale, chrome install wiped, swap gone,
  .git wiped) — exactly the failure mode reapply8 was built for. `bash tools/serve.sh`
  (one command) fully recovered: reapply8 rewrote openai.ts + openai-client.mjs, re-patched
  server.ts reconcile + jobs.ts guard removal, rebuilt dist, git re-snapshot (ccc71b5 now
  CONTAINS the fixed tree, so future snapshots inherit the fixes), chrome re-downloaded
  (`npx hyperframes browser ensure` — serve.sh only warns; hyperframes needs the ensure call
  or a render to trigger the download), swap 3GB auto-healed (NEW in serve.sh: idempotent
  fallocate/mkswap/swapon block). Tests post-restore: openai-client 15/15, failover 9/9.
  E2E 8d8c017e ran on this stack. **The reset-proofing is now closed-loop.**
- **RESET #21 DRIFT + REPAIR (2026-09-17)**: reset #21 rolled the tree back past BOTH the
  openai.ts live-API fix and the crash-consistency reconcile (the surviving reapply1-7 chain
  predates them; the writers write nothing for openai). Detected by symptom: a fresh job
  logged "ai[video]: no provider available — heuristic offline mode" while /v1/config said
  openai configured (the video 400 put openai in 90s cooldown; analyze/plan then skipped).
  Live API errors found + fixed (all now locked in test/openai-client.mjs, 15/15):
  (a) image data URL must be `data:<mime>;base64,<b64>` — the old tree sent it WITHOUT the
  comma → "Invalid 'input[0].content[0].image_url' ... without the ',' separator";
  (b) text.format must be `json_object` (not `json`); (c) temperature is 400'd by gpt-5.6-*
  → per-model auto-learning + retry. Fix persisted via tools/reapply8.py (wired into
  serve.sh after reapply7). LIVE-PROVEN on job 60c52c6d: ai[video] ok in 10s (16 frames),
  ai[analyze] ok in 12s, ai[plan] ok in 19s — full openai/gpt-5.6-luna pipeline.
  NOTE: retrying a DONE job re-uses ALL persisted stage outputs (audio/transcribe/analyze/
  plan/prep/package) — it does NOT re-run the AI. To force a fresh AI pass, upload a new
  project. The startup reconcile was live-verified on this stack (orphaned a5503dde marked
  'interrupted' at boot after a SIGKILL'd server).
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

## Current good state (2026-09-18, post reset #24 — closed-loop self-heal proven)
- **Reset-proofing is CLOSED-LOOP and 100% OFFLINE.** Resets #21–#28 (eight in one
  session) each rolled the tree back, wiped chrome/swap/git/data/server; each recovered
  with ONE command (`bash tools/serve.sh`): reapply8 re-applies the openai contract +
  reconcile fixes, **chrome restores offline from the bundled tools/ zip** (added
  2026-09-18: 152.0.7977.30-chrome-headless-shell-linux64.zip, 119MB — no more network
  download after resets), swap self-heals, git re-snapshots (snapshot CONTAINS the
  fixed tree). Fresh agent workspace without the zip: `npx hyperframes browser ensure`.
- **Every acceptance path re-proven on the post-#24 stack (2026-09-18):**
  - Crash-resume E2E (job 89b2e2ae) **ALL PASS** via `tools/crash-resume-e2e.sh`:
    kill -9 mid-render → restart → startup reconcile → `interrupted` → POST /retry →
    5 persisted-stage reuses → done, 2 MP4s, download verified.
  - Cancel path: POST /cancel during transcribe → `cancelled` / "cancelled by user".
  - E2E 5b36725b: 788s, QC 1/1, live openai/gpt-5.6-luna (video 14s/analyze 11s/plan 22s),
    on-demand variant endpoint 200→render→200, all downloads 200.
  - Tests: openai-client 15/15 · failover 9/9 · regression 22/22.
  - UI 5/5 fresh screenshots (docs/ui-*.png) — live provider badges visible.
- **Handoff for a new agent: README.md "Agent handoff" section** (one-command recovery,
  the 3 test gates, AI config location, exact push command with PAT placeholder, rules).
- **Only outstanding item: GitHub push needs a PAT** (never stored in the sandbox —
  searched exhaustively: no helper/store/env/gh/token-shaped strings). Remote:
  `dev/finish-pipeline` on clipuni34-coder/Syntheniq; local head: 64f8c3b.
- Push history: only 79bd34b (crash-consistency) was ever pushed (remote was wiped by
  reset #20 along with the PAT). Everything after — the chrome icudtl heal, the openai
  contract fixes, the reapply8 persistence, swap heal, handoff docs, this E2E harness —
  is local-only and must be pushed when a PAT is available.

### History (2026-09-16, post reset #8 — full chain proven again)
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

## 2026-09-18 — cross-provider model-family fix (post e9bbae9)
Bug: global AI_MODEL (e.g. gpt-5.6-luna) was forwarded to *every* provider,
so AI_PROVIDER=gemini + AI_MODEL=gpt-* 404'd all gemini calls (silent heuristic
degradation). Fix: config.ts MODEL_FAMILY + modelFitsProvider — explicit models
(per-task or AI_MODEL) are honored only when the model family matches the
provider, else the provider's own tier default is used. router.ts applies the
same check to REVIEW_MODEL. Regression: test/model-routing.mjs (20/20).
Live proof (job 6f1f16e2, gemini primary, 500s, QC 1/1): gemini served
package (gemini-3.5-flash-lite ok 2s) + review fell to openai + heuristic
only when both providers throttled. Tests 66/66 total (20+15+22+9).
