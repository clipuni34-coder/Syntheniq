# Syntheniq — Implementation Plan (2026-09-15)

Goal: private personal automated viral-video editor.
`UPLOAD → TRANSCRIBE → AI ANALYZE → AI CLIP PLAN → EDIT DECISIONS → HYPERFRAMES + FFMPEG RENDER → DOWNLOAD MP4 + METADATA`

## 1. What exists (inspected from git @ 200f4a0)

| Piece | State |
|---|---|
| `apps/api` Fastify server | **Partially working**: `/health`, `POST /v1/projects`, upload (multipart → disk). `POST .../analyze` is a **stub** (returns fake `queued`). No pipeline, no jobs, no serving of web build. |
| `apps/web` Next.js | **Landing page only**. Dropzone UI exists but is **not wired** to any API. No project/results views. `next.config.mjs` missing `output:'export'` required by Dockerfile. |
| `docs/PRODUCT.md` | **Working spec** — 11-step workflow, editorial score weights (hook 25 / curiosity 20 / payoff 20 / standalone 15 / emotion 10 / visual 10), non-negotiable: transcript must cover full media duration. |
| `Dockerfile` | **Declared but broken**: references `npm run build:web`, `npm ci` (no lockfile committed), `dist/server.js`, `/v1/health` (server has `/health`), node:20 (HyperFrames needs ≥22), no Chrome headless pre-cache, whisper model `tiny`. |
| `packages/editor`, `workers/` | Empty dirs. No queue, no storage abstraction, no DB. |

## 2. Architecture decisions (respecting existing)

- **Single process**: Fastify API + embedded pipeline worker + static web export (as the Dockerfile intended). One Docker image, one port (8787), data in `SYNTHENIQ_DATA` volume. Personal workstation — no Redis/Postgres (README's "in production" items stay out).
- **Transcription**: local **faster-whisper** (word-level timestamps + VAD), as the Dockerfile already bakes in Python. Model via env (`SYNTHENIQ_WHISPER_MODEL`, default `small`).
- **AI**: **OpenAI Responses API** (per README), structured JSON output, model via env (default `gpt-4.1-mini`). **Heuristic offline fallback** when no key is set (silence/topic segmentation + template metadata) so the pipeline is fully testable and usable offline; UI labels which mode ran.
- **Rendering**: **HyperFrames CLI** (official, Node 22) for composition (captions, punch-ins, hooks, cutaways, CTA, progress) + **FFmpeg** for reframe/segment cuts, audio ducking mix, SFX placement, thumbnails, QC. Final audio pre-mixed in FFmpeg (voice + ducked music + SFX) and carried by a single `<audio>` clip; video segments are silent.
- **Storage**: flat per-project dirs under `SYNTHENIQ_DATA` (existing upload path), `job.json` state machine so status survives restarts.

## 3. Pipeline stages (job.json)

1. `media-check` — ffprobe (duration, 30/60 fps detect, resolution, audio).
2. `audio` — extract 16 kHz mono WAV.
3. `transcribe` — faster-whisper; **coverage gate**: last word ≥ 95% of duration, else retry (PRODUCT.md non-negotiable).
4. `analyze` — LLM: story map, emotional beats, keyphrases, dead air, filler patterns, candidate moments with editorial scores. (Heuristic fallback: silence+energy segmentation.)
5. `plan` — LLM decides **number of clips** (max genuinely usable, 25–55 s each, chronological, never combining unrelated topics) + per-clip edit decisions: kept segments (dead air/filler cuts), punch-in beats, B-roll cutaways (source-derived), hook text, callouts, CTA, thumbnail spec, music mood, variants. Code-side validation clamps/repairs the plan.
6. `prep-media` — per clip: FFmpeg cut each kept segment, reframe to 1080×1920 (lanczos), 30/60 fps per source; concat segment audio + sidechain-ducked music bed + synthesized SFX at cue times → `mixed.m4a`; select music by AI mood (bundled generated beds; user files in `assets/audio` override).
7. `render` — generate HyperFrames composition per clip (9:16, kinetic karaoke captions from word timestamps, keyphrase emphasis, GSAP punch-in zooms, hook card, B-roll cutaway, progress bar, CTA) → `npx hyperframes render --fps <src> --quality standard`.
8. `package` — per clip: title, caption, description, hashtags, CTA, variants (LLM, or template) + thumbnail (FFmpeg drawtext on AI-picked hero frame).
9. `qc` — ffprobe every output (1080×1920, fps, duration, audio stream, size). Fail loudly.
10. `complete` — results served; MP4 + thumbnail + metadata downloadable from the UI.

## 4. Web (single user, iPhone Safari)

- Keep existing landing page + visual language; wire dropzone (XHR upload with progress bar).
- `/project?id=<uuid>`: live stage tracker + log, then results grid (player, **Download MP4**, thumbnail, copy title/caption/hashtags/CTA, variants).
- Optional single passcode gate (`SYNTHENIQ_PASSWORD`) — privacy, not accounts.

## 5. Deployment

- Dockerfile fixed: **node:22**, committed `package-lock.json`, faster-whisper `small` baked, `chrome-headless-shell` pre-cached via `npx hyperframes browser`, web `output:'export'` served by API, `/v1/health` alias, data volume, 8787.
- Run anywhere Docker runs (Fly.io/VPS). LAN or preview host reachable from iPhone Safari.

## 6. Needed from owner (only)

1. `OPENAI_API_KEY` (full AI moment-selection + packaging; heuristic mode works without it).
2. A host to run the Docker image (or use the live preview from this session).
3. Optional: GitHub token to push the finished tree to `clipuni34-coder/Syntheniq`.
4. Optional: personal music/SFX drops in `apps/api/assets/audio`, Pexels key for stock B-roll (off by default — B-roll is source-derived).

## 7. What is deliberately NOT built

Subscriptions, billing, accounts, multi-user, marketplace, SaaS dashboards. None.
