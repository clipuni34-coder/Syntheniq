# Syntheniq — container image.
# Stage 1 builds the static web export; stage 2 runs the API + engine
# (FFmpeg + local transcription) and serves the studio itself.
# Runs on any container host (Fly.io, VPS + Compose) — not on Workers.
#
# Build arg:
#   NEXT_PUBLIC_API_URL  public origin baked into the studio (required when
#                        the public URL has no :8787 port, i.e. always in
#                        production). Example: https://preview.example.com

# ---- web export -----------------------------------------------------------
FROM node:20-bookworm-slim AS web
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @syntheniq/web --include-workspace-root=false
COPY apps/web ./apps/web
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN npm run build:web

# ---- api runtime ----------------------------------------------------------
FROM node:20-bookworm-slim AS api
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip fonts-dejavu \
  && rm -rf /var/lib/apt/lists/*

# Bake the default whisper model so cold starts never download weights.
RUN pip3 install --no-cache-dir --break-system-packages faster-whisper \
  && python3 -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8')"

<<<<<<< ours
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @syntheniq/api --include-workspace-root=false
COPY apps/api ./apps/api
COPY --from=web /repo/apps/web/out ./apps/api/web-out
RUN npm run build --workspace @syntheniq/api \
  && npm prune --workspace @syntheniq/api --omit=dev
=======
WORKDIR /app
COPY apps/api/package.json ./
RUN npm install
COPY apps/api ./
COPY --from=web /repo/apps/web/out ./web-out
RUN npm run build && npm prune --omit=dev
>>>>>>> theirs

WORKDIR /repo/apps/api
ENV NODE_ENV=production \
  PORT=8787 \
  SYNTHENIQ_DATA=/repo/apps/api/data \
  WEB_OUT_DIR=/repo/apps/api/web-out

<<<<<<< ours
VOLUME /repo/apps/api/data
=======
VOLUME /app/data
>>>>>>> theirs
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch(`http://127.0.0.1:${process.env.PORT || 8787}/v1/health`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Default: API + embedded worker (single-node). Scale-out: run API replicas
# with API_ONLY=1 and this same image as workers via `node dist/worker.js`.
CMD ["node", "dist/server.js"]
