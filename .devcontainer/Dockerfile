FROM mcr.microsoft.com/devcontainers/typescript-node:20-bookworm

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      espeak-ng \
      python3 \
    && rm -rf /var/lib/apt/lists/*

# Ensure node user can run everything
USER node
