# Syntheniq — container image.
# Stage 1 builds the static web export; stage 2 runs the API + engine
# (FFmpeg + local transcription + HyperFrames headless-Chrome renderer)
# and serves the studio itself.
#
# Runs on any container host (Fly.io, VPS + Docker/Compose) — not on Workers.
#
# Build arg:
#   NEXT_PUBLIC_API_URL  public origin baked into the studio (required when
#                        the public URL has no :8787 port). Example:
#                        https://syntheniq.example.com
#
# Note: rendering needs a few GB of RAM (headless Chrome + FFmpeg).
# Deploy with at least 2 vCPU / 2 GB (4 GB recommended for 1080x1920 @60fps).

# ---- web export -----------------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @syntheniq/web --include-workspace-root=false
COPY apps/web ./apps/web
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN npm run build:web

# ---- api runtime ----------------------------------------------------------
# HyperFrames requires Node >= 22.
FROM node:22-bookworm-slim AS api
# ffmpeg: media engine.
# python3/pip + faster-whisper: local transcription fallback.
# The libnss3/libgbm1/... set: system libraries required by the headless
# Chrome that HyperFrames uses to render compositions (verified against
# the official CLI's own missing-library report).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg python3 python3-pip fonts-dejavu \
       libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
       libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
       libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 \
  && rm -rf /var/lib/apt/lists/*

# Bake the default whisper model (config default: 'small') so cold starts
# never download weights.
RUN pip3 install --no-cache-dir --break-system-packages faster-whisper \
  && python3 -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @syntheniq/api --include-workspace-root=false
COPY apps/api ./apps/api
COPY --from=web /repo/apps/web/out ./apps/api/web-out
RUN npm run build --workspace @syntheniq/api \
  && npm prune --workspace @syntheniq/api --omit=dev

# Pre-cache HyperFrames' bundled headless Chrome so the first render never
# has to download ~115 MB (official: `npx hyperframes browser`).
RUN npx hyperframes browser ensure || npx hyperframes browser

WORKDIR /repo/apps/api
ENV NODE_ENV=production \
  PORT=8787 \
  SYNTHENIQ_DATA=/repo/apps/api/data \
  WEB_OUT_DIR=/repo/apps/api/web-out \
  HOME=/root

# Project data (sources, transcripts, compositions, rendered clips) lives on
# a volume so it survives container recreation.
VOLUME /repo/apps/api/data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch(`http://127.0.0.1:${process.env.PORT || 8787}/v1/health`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
