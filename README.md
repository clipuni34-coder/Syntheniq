# Syntheniq

A **private, personal automated viral-video editor**.

Upload a talking-head source video from your phone → Syntheniq transcribes it, an AI editorial layer (or a local heuristic engine) finds the strongest moments and writes the full edit decision → HyperFrames + FFmpeg render 9:16 clips with kinetic captions, punch-ins, cutaways, music and SFX → automatic QC → separate finished clips with titles, per-platform captions, hashtags, CTA, thumbnail, source timestamps and edit rationale → download to your phone.

Single-user by design. No accounts, no billing, no dashboards.

## Workflow

```
iPhone Safari → private passcode-protected URL
  → upload source video (streamed to disk, never through the browser twice)
  → ANALYZING     media check + audio extract
  → TRANSCRIBING  Gemini API (if configured) or local faster-whisper (word-level, VAD)
  → SELECTING     AI picks the maximum number of genuinely usable clips + hooks
  → BUILDING      edit decisions: cuts, punch-ins, B-roll, SFX, music, captions
  → RENDERING     HyperFrames (headless Chrome) + FFmpeg, 1080x1920 @ source fps
  → QC            decode, duration, fps, resolution, audio, caption presence,
                  composition lint — with one automatic re-render on failure
  → RESULTS       preview + download (MP4, thumbnail, posting metadata)
```

Every intermediate result is persisted per project (`data/projects/<id>/`):
`job.json` (stage state machine), `audio.wav`, `transcript.json`, `analysis.json`,
`plan.json`, `media/<clip>/` (segments + mixed audio + `spec.json`),
`comp/<clip>/` (HyperFrames composition), `files/` (final MP4 + meta + thumbnail).
A job that fails or is interrupted can be **retried from the failed stage** —
finished stages are reused, never redone.

## Architecture

| Layer | Tech |
|---|---|
| Web | Next.js (static export) — minimal, mobile-first, passcode-gated |
| API | Node.js 22 + Fastify, single process, embedded serial job queue |
| AI | Multi-provider abstraction: **Gemini / OpenAI / xAI Grok**, per-task routing, automatic failover, second-pass review, heuristic offline fallback |
| Transcription | Gemini Interactions Transcribe API (preferred when configured) → local **faster-whisper** fallback (word timestamps, 95% coverage gate) |
| Editing decisions | Structured `CompSpec` per clip (segments, cutaways, punch-ins, callouts, SFX, music, hook, CTA) |
| Rendering | **HyperFrames** (official CLI, headless Chrome) compositions + **FFmpeg** media prep/muxing |
| Storage | Local filesystem (`SYNTHENIQ_DATA`), atomic job persistence — no Postgres/Redis by design |

The AI layer is the editorial brain; HyperFrames renders; FFmpeg handles media.
With **zero API keys** the pipeline still runs end-to-end on the built-in
heuristic engine (silence/energy beats + transcript structure).

## Running locally

Requirements: Node ≥ 22, FFmpeg, Python 3 (for local transcription).

```bash
npm install
npm run build:web   # static site → apps/web/out
npm run build:api   # tsc → apps/api/dist

cd apps/api
SYNTHENIQ_DATA=$PWD/data \
WEB_OUT_DIR=../../apps/web/out \
SYNTHENIQ_PASSWORD=yourpass \
node dist/server.js
```

Open `http://localhost:8787` (from your phone: your machine's LAN IP).
Enter the passcode, upload a video, watch the pipeline, download the clips.

## Configuration (`.env` / environment)

| Variable | Purpose |
|---|---|
| `SYNTHENIQ_PASSWORD` | Passcode for the private interface (required) |
| `PORT` | API port (default 8787) |
| `SYNTHENIQ_DATA` | Data directory (default `<repo>/data`) |
| `WEB_OUT_DIR` | Static web export to serve (default `<repo>/apps/web/out`) |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini — analysis, planning, packaging, cloud transcription |
| `OPENAI_API_KEY` | OpenAI — analysis, planning, packaging |
| `XAI_API_KEY` | xAI Grok — analysis, planning, packaging |
| `AI_PROVIDER` | Primary provider: `gemini` \| `openai` \| `grok` (default: best configured) |
| `AI_FALLBACK` | Comma-separated failover order (default: all configured providers) |
| `AI_MODEL` | Optional global model override (per-task overrides still apply) |
| `SYNTHENIQ_TRANSCRIBE` | `gemini` to prefer cloud transcription (needs Gemini key) |
| `SYNTHENIQ_WHISPER_MODEL` | Local whisper model (default `small`) |

Keys are server-side only and never reach the browser. Any subset of keys
works; providers fail over automatically on quota/rate-limit/outage.

## Docker (persistent deployment)

The Dockerfile bakes in FFmpeg, faster-whisper (`small`), and HyperFrames'
headless Chrome (so the first render has no 115 MB download):

```bash
docker build --build-arg NEXT_PUBLIC_API_URL=https://syntheniq.example.com -t syntheniq .

docker run -d --name syntheniq \
  -p 8787:8787 \
  -v syntheniq-data:/repo/apps/api/data \
  -e SYNTHENIQ_PASSWORD=yourpass \
  -e GEMINI_API_KEY=... -e OPENAI_API_KEY=... -e XAI_API_KEY=... \
  syntheniq
```

The data volume keeps projects across restarts. The image is self-contained:
it must not depend on any development sandbox. Render sizing: 2 vCPU / 2 GB
minimum, 4 GB recommended.

## Repository layout

```
apps/web/      Next.js studio (passcode → upload → pipeline view → results)
apps/api/
  src/server.ts      Fastify app: auth, upload, projects, files, retry, static web
  src/jobs.ts        serial queue + atomic job persistence (resume/interrupt)
  src/store.ts       per-project file store
  src/ai/            provider clients (gemini/openai/grok) + router + heuristic
  src/pipeline/      media-check → transcribe → analyze → plan → prep → render → package → qc
  tools/             whisper wrapper + asset generators
  assets/            vendored gsap, fonts, generated music beds + SFX
docs/PLAN.md         implementation plan & decisions
tools/               test-source generator (piper TTS + testsrc2)
```

## Editing contract

- 9:16 1080×1920, source fps (30/60)
- strict chronological dialogue — never reordered, looped or spliced
- lip-sync preserved by construction (A/V cut from identical source ranges)
- dead air + filler removed at sentence boundaries
- kinetic word-level captions with keyphrase emphasis (karaoke pop-in)
- punch-ins / cutaways / callouts / SFX / music only where the plan justifies them
- maximum number of genuinely usable clips — each self-contained with hook + payoff
- per-clip package: MP4, title, TikTok/IG/YT captions, hashtags, CTA,
  thumbnail, source timestamps, edit rationale, optional variants
