# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Syntheniq GitHub Codespaces devcontainer — the SAME environment as the
# production Dockerfile (node:22-bookworm + ffmpeg with drawtext + python3
# faster-whisper/edge-tts + HyperFrames CLI + pre-cached headless Chrome),
# built natively (Codespaces have no Docker daemon — the app runs directly
# on the Codespace's Ubuntu VM, which is what "an equivalent environment"
# means: identical packages, identical versions, same binaries).
#
# Everything user-specific (Chrome cache, whisper model, npm cache) is
# installed as the devcontainer's regular user (uid 1000) so it lands in
# $HOME/.cache and persists with the Codespace across hibernate/resume.
#
# First codespace creation builds this image once (a few minutes); GitHub
# caches it per commit.
# ─────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm

ARG DEBIAN_FRONTEND=noninteractive

# System packages — identical set to the production Dockerfile:
#   ffmpeg            media engine (Debian build includes drawtext —
#                     captions/thumbnails REQUIRE it)
#   python3/pip       local faster-whisper transcription + edge-tts
#   fonts-dejavu      a real font for drawtext
#   libnss3/libgbm1/… the exact system libraries the headless Chrome
#                     HyperFrames uses to render (verified against the
#                     official CLI's missing-library report;
#                     libasound2 = bookworm's package — libasound2t64 is
#                     Debian trixie (13)/Ubuntu 24.04, NOT bookworm (12);
#                     fixed from libasound2t64 which 404'd on build)
#   tmux              keeps the server alive after container setup
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip fonts-dejavu ca-certificates \
      curl unzip tmux \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    && rm -rf /var/lib/apt/lists/*

COPY . /repo
RUN chown -R node:node /repo

# From here on: the regular devcontainer user (uid 1000). All caches land
# in /home/node/.cache → persist with the Codespace.
USER node

# Python side: local transcription (private, no key needed) + edge-tts.
# Bake the default whisper model ('small', ~460 MB) so the first project
# never waits on a weights download.
RUN python3 -m pip install --no-cache-dir --break-system-packages faster-whisper edge-tts \
    && python3 -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

WORKDIR /repo

# App deps (npm workspaces; hyperframes is a production dep).
RUN npm ci --no-audit --no-fund

# HyperFrames' own headless Chrome (official CLI, version-aware, idempotent)
# so the first render never downloads ~115 MB and never hits a partial
# install (missing icudtl.dat → IMMEDIATE_CRASH → render hangs).
RUN npx hyperframes browser ensure || npx hyperframes browser

# Build the static studio + API (NEXT_PUBLIC_API_URL unset → the UI calls
# the API on the same origin: exactly one forwarded port).
RUN npm run build

# Persistent data (survives hibernation/resume; lost only on a workspace
# reset or GitHub's inactivity retention — see RUNBOOK) + a main-disk
# TMPDIR (the Codespace's /tmp is a RAM-backed tmpfs).
RUN mkdir -p /home/node/syntheniq-data /home/node/tmp
