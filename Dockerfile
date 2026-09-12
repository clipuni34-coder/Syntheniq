# Syntheniq — container image.
# Stage 1 builds the static web export; stage 2 runs the API + engine
# (FFmpeg + local transcription) and serves the studio itself.
# Runs on any container host or Cloudflare Containers (not on Workers).

# ---- web export -----------------------------------------------------------
FROM node:20-bookworm-slim AS web
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN npm install --workspace @syntheniq/web --include-workspace-root=false 2>/dev/null \
  || npm install --workspace @syntheniq/web
COPY apps/web ./apps/web
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN npm run build:web

# ---- api runtime ----------------------------------------------------------
FROM node:20-bookworm-slim AS api
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip fonts-dejavu \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages faster-whisper \
  && python3 -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8')"

WORKDIR /app
COPY apps/api/package.json ./
RUN npm install --omit=dev
COPY apps/api ./
COPY --from=web /repo/apps/web/out ./web-out
RUN npm run build

ENV NODE_ENV=production \
    PORT=8787 \
    SYNTHENIQ_DATA=/app/data \
    WEB_OUT_DIR=/app/web-out

VOLUME /app/data
EXPOSE 8787

CMD ["node", "dist/server.js"]
