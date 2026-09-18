# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Syntheniq — self-hosted AI video-editing pipeline (single-user, no SaaS).
#
#   Build:  docker build -t syntheniq .
#   Run:    docker run -d --name syntheniq -p 8787:8787 \
#              -v syntheniq-data:/data \
#              -e OPENAI_API_KEY=... -e GEMINI_API_KEY=... \
#              syntheniq
#   → open http://localhost:8787  (password: SYNTHENIQ_PASSWORD)
#
# Or:  cp .env.example .env  &&  docker compose up -d --build
#
# Stages
#   web     — builds the static studio export (bakes NEXT_PUBLIC_API_URL when set)
#   app     — Node 22 + ffmpeg(drawtext) + python3/faster-whisper/edge-tts +
#             HyperFrames CLI + pre-cached headless Chrome (no first-run
#             ~115 MB download, no icudtl.dat problems) + baked whisper model
#
# Render needs a few GB of RAM (headless Chrome + FFmpeg). Deploy with
# ≥ 2 vCPU / 4 GB; 1080p60 prefers 8 GB / 4 vCPU.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS base
ENV DEBIAN_FRONTEND=noninteractive
# ffmpeg: media engine (Debian build includes drawtext — captions/thumbnails).
# fonts: drawtext needs a real font.
# python3/pip: local faster-whisper transcription + edge-tts.
# libnss3/libgbm1/... set: system libraries required by the headless Chrome
# HyperFrames uses to render (verified against the official CLI's own
# missing-library report; libasound2t64 = bookworm's time_t64 name).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip fonts-dejavu ca-certificates curl unzip \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 \
    && rm -rf /var/lib/apt/lists/*

# ---- web export (static studio) -------------------------------------------
FROM base AS web
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @syntheniq/web --include-workspace-root=false
COPY apps/web ./apps/web
# Public origin baked into the studio (required when the public URL has no
# :8787 port, e.g. reverse-proxied at https://syntheniq.example.com).
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN npm run build:web

# ---- app runtime (final) ----------------------------------------------------
FROM base AS app
WORKDIR /repo
# Python side: local transcription (private, no key) + TTS; bake the default
# whisper model ('small', ~460 MB) so cold starts never download weights.
RUN python3 -m pip install --no-cache-dir --break-system-packages faster-whisper edge-tts \
    && python3 -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
# App deps (npm workspaces; hyperframes is a production dep → survives prune).
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @syntheniq/api --include-workspace-root=false
# Pre-cache HyperFrames' bundled headless Chrome (official CLI, version-aware)
# so the first render never downloads ~115 MB and never hits a partial
# install (missing icudtl.dat → IMMEDIATE_CRASH → 40-minute render hangs).
RUN npx hyperframes browser ensure || npx hyperframes browser
# Build the API, then strip dev deps.
COPY apps/api ./apps/api
RUN npm run build:api && npm prune --workspace @syntheniq/api --omit=dev
# Static studio (default WEB_OUT_DIR resolves to /repo/apps/web/out).
COPY --from=web /repo/apps/web/out ./apps/web/out
# (chrome + whisper model caches already live in /root/.cache of this stage —
#  hyperframes/whisper look under $HOME at runtime)
RUN mkdir -p /data
ENV NODE_ENV=production \
    PORT=8787 \
    HOME=/root \
    SYNTHENIQ_DATA=/data \
    SYNTHENIQ_PASSWORD=syntheniq-2026
# Project data (sources, transcripts, compositions, rendered clips) lives on a
# volume so it survives container recreation.
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
  CMD node -e "fetch(\`http://127.0.0.1:\${process.env.PORT || 8787}/v1/health\`).then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
