FROM mcr.microsoft.com/devcontainers/typescript-node:20-bookworm

# Install ffmpeg and dependencies for video processing
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*
