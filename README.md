# Syntheniq

AI video editing that understands the story.

Upload one long video. Syntheniq transcribes it, checks the transcript against
the real runtime, ranks the moments worth clipping, and renders finished
9:16 vertical shorts with burned-in captions — verified spec-by-spec before
you download.

**Flow:** Home → New Project → Upload → Analyzing → Clips Found →
Clip Preview → Export → Download.

## MVP

Upload a video → analyze/transcribe → rank moments → create edit decisions →
render 9:16 clips → export MP4 + thumbnail + posting metadata.

See `docs/PRODUCT.md` for the product spec (scoring weights, editorial rule).

## Architecture

- Web: Next.js/React (fully client-side studio, statically exported)
- API: Node.js/TypeScript (Fastify) + Python worker for local transcription
- AI: OpenAI transcription API when keyed, otherwise local faster-whisper,
  otherwise honest audio-structure analysis (never invented words)
- Rendering: FFmpeg first, Remotion reserved for advanced graphics later
- Storage: local disk in development, S3-compatible object storage
  (Cloudflare R2 in production)
- Queue: in-process jobs in development, Redis/BullMQ in production
- Database: JSON document store in development, Postgres/Supabase in production

## Current development mode

This repository is a local-first vertical slice. No API keys are committed.

Prerequisites: **Node ≥ 18**, **FFmpeg 6+** (`ffmpeg` + `ffprobe` on PATH),
**Python 3** with `faster-whisper` for local transcription
(`pip install faster-whisper`; skipped automatically if `OPENAI_API_KEY` is set).

```bash
npm install
cp .env.example .env   # optional — defaults work out of the box

# Terminal 1: API + engine (http://localhost:8787)
npm run dev:api

# Terminal 2: studio with hot reload (http://localhost:3000)
npm run dev:web
```

Or serve the built studio straight from the API (single command):

```bash
npm run build:web   # static export → apps/web/out, served by the API
npm run dev:api      # studio + API together on http://localhost:8787
```

Run the suite (includes a real upload → analyze → export → download pass
over HTTP with synthetic speech media — no API keys needed):

```bash
npm test
```

Regenerate the synthetic demo/test media:

```bash
npm run fixtures
```

## Repository layout

```
apps/api/     Fastify API + engine (probe, structure, transcribe,
              editorial ranking, render, storage seams) + tests
apps/web/     Next.js studio (static export → Cloudflare Pages)
docs/         Product spec
```

`GET /v1/health` reports engine capability (FFmpeg presence, transcription
route, storage driver).

## Cloudflare hosting

- `apps/web/out` (after `npm run build:web`) deploys to **Cloudflare Pages** as-is.
- Media goes to **R2** via `STORAGE_DRIVER=r2` + `R2_*` secrets (needs the
  optional `@aws-sdk/client-s3` package in `apps/api`).
- The Node + FFmpeg engine runs in **Docker** (`Dockerfile` included) on any
  container host or Cloudflare Containers — Workers cannot run FFmpeg/whisper.
- `wrangler.toml` documents the intended bindings.

## Remaining integration points (all explicit, none blocking)

- **Higher-quality transcription:** set `OPENAI_API_KEY` — no code change.
- **R2 storage:** set `STORAGE_DRIVER=r2` + `R2_*` secrets and install
  `@aws-sdk/client-s3` in `apps/api`; without them the app runs fully on local disk.
- **Durable job queue** for multi-instance deploys: replace
  `apps/api/src/lib/jobs.ts` (BullMQ / Cloudflare Queues); routes only depend
  on its function interface.
- **Managed database:** replace `apps/api/src/lib/db.ts` (Postgres/Supabase/D1).
