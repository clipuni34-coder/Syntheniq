# Docker deployment

One image, one volume, one port. No database, no SaaS, no multi-tenancy.

## Requirements

- Docker (any modern version) with `docker compose` v2
- A host with **≥ 4 GB RAM and 2 vCPU** (8 GB / 4 vCPU recommended for 1080p renders)
- At least one AI key (OpenAI / Gemini / xAI) for AI analysis & planning —
  with no keys the app still runs in built-in **heuristic (offline) mode**

## Quick start

```bash
cp .env.example .env          # add at least one AI key + set SYNTHENIQ_PASSWORD
docker compose up -d --build
# → open http://localhost:8787  (password from .env)
```

That's it. All state (uploads, renders, jobs, whisper model) persists in the
named volume `syntheniq-data`.

## What's in the image

| Layer | Purpose |
|---|---|
| Node 22 | API server; hyperframes CLI requires Node ≥ 22 |
| ffmpeg/ffprobe (Debian, **drawtext**) | caption burn-in, thumbnails, media prep |
| python3 + faster-whisper + edge-tts | local private transcription + narration |
| chrome-headless-shell 152.0.7977.30 | hyperframes render engine, pre-placed at the cache path hyperframes expects (no first-run download, no icudtl.dat problems) |
| app + npm workspaces | API, pre-built web UI (`apps/web/out`), hyperframes CLI |

The image contains **no keys** — AI credentials come from `.env` at runtime
(`docker compose` maps them into the container's environment).

## Operations

```bash
docker compose logs -f            # follow pipeline logs (stage per line)
docker compose restart            # restart (jobs marked 'interrupted' can be retried from the UI)
docker compose down               # stop (volume + data kept)
docker compose down -v            # stop AND erase all projects/renders
docker volume inspect syntheniq_syntheniq-data   # see stored size
```

**Upgrades:** pull the new code, `docker compose up -d --build`. Old jobs
survive in the volume; interrupted ones show as retriable in the UI.

## Notes & limits

- **Single user by design** — one passcode, no accounts. Put it behind a
  reverse proxy (Caddy/nginx) with TLS + basic-auth if you expose it.
- **Renders are heavy** — a 45 s multi-clip render uses several GB of RAM and
  minutes of CPU. The compose file requests 8 GB; don't schedule heavy work
  on a starved box.
- **Whisper model** (`small`, ~460 MB) is baked into the image — no
  first-run download. Changing `SYNTHENIQ_WHISPER_MODEL` to another size
  downloads that model on first use (into the container, not the volume).
- **Chrome** is pre-cached at build time via HyperFrames' own
  `browser ensure` (version-aware — no pin to manage); first render never
  downloads and never hits a partial install.
- **Reverse proxy / custom origin** — set `NEXT_PUBLIC_API_URL` in `.env`
  and rebuild (`docker compose up -d --build`); the studio bakes that origin.
