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
- Editorial: deterministic heuristic ranking always; an LLM pass
  (OpenAI Responses API, structured outputs) re-scores the top candidates
  with full transcript context when `OPENAI_API_KEY` is set — each clip
  records which layer decided it (`decidedBy`), and any LLM failure keeps
  the heuristic scores
- Rendering: FFmpeg first, Remotion reserved for advanced graphics later
- Storage: local disk in development, Cloudflare R2 (S3-compatible,
  presigned downloads) in production — enforced at boot
- Queue: persistent jobs with leases + heartbeats (survive restarts, any
  number of workers via atomic `FOR UPDATE SKIP LOCKED` claims)
- Database: JSON document store in development, Postgres in production —
  enforced at boot (`DATABASE_URL` required with `NODE_ENV=production`)

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

`GET /v1/health` reports engine capability (persistence, storage driver,
worker mode, FFmpeg presence, transcription route).

## Production topology

One codebase, two process types, shared state:

```bash
# API replicas (no embedded worker)
API_ONLY=1 NODE_ENV=production DATABASE_URL=... STORAGE_DRIVER=r2 ... node apps/api/dist/server.js

# Worker pool (as many as needed; claims are atomic, leases self-heal)
NODE_ENV=production DATABASE_URL=... STORAGE_DRIVER=r2 ... node apps/api/dist/worker.js
```

- **Postgres** holds projects + jobs; workers claim via `SELECT … FOR UPDATE
  SKIP LOCKED` with lease heartbeats, so crashed workers' jobs are reclaimed
  automatically. Boot refuses to start production on the JSON store.
- **R2** holds every durable artifact (sources, transcripts, analyses,
  posters, exports). Downloads are presigned URLs — media never proxies
  through the API. Boot refuses production on local storage.
- Large-video behavior is structural: chunked transcription past 15 minutes,
  streaming (constant-memory) energy analysis, byte-counted upload caps.
- Integration tests prove the real backends (`TEST_DATABASE_URL` for
  Postgres, `TEST_S3_ENDPOINT` for any S3-compatible store); they skip when
  the backends are unreachable.

## Cloudflare hosting

- `apps/web/out` (after `npm run build:web`) deploys to **Cloudflare Pages** as-is.
- Media goes to **R2** via `STORAGE_DRIVER=r2` + `R2_*` secrets.
- The Node + FFmpeg engine runs in **Docker** (`Dockerfile` included) on any
  container host or Cloudflare Containers — Workers cannot run FFmpeg/whisper.
- `wrangler.toml` documents the intended bindings.

## Remaining integration points (all explicit, none blocking)

- **Higher-quality transcription:** set `OPENAI_API_KEY` — no code change.
- **LLM editorial scores:** same key enables the editorial pass
  (`OPENAI_EDITORIAL_MODEL`, `LLM_TOP_K` to tune); without it the heuristic
  ranking stands.
- **R2 storage:** set `STORAGE_DRIVER=r2` + `R2_*` secrets; without them the
  app runs fully on local disk (dev) or refuses to boot (production).
- **Managed Postgres:** set `DATABASE_URL` (Supabase/RDS/Neon all work —
  plain SQL over `pg`, no extensions needed).
