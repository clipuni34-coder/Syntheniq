# Syntheniq AI Video Editor

An end-to-end AI-powered video editing pipeline that transforms short clips into polished, captioned videos with intelligent B-roll integration and viral caption styles.

## Features

- **AI-Powered Analysis** - Transcribes audio using OpenAI Whisper or local faster-whisper, detects scene structure, and identifies key moments
- **Smart Captioning** - Generates 6 viral caption styles (Hormozi, MrBeast, Karaoke, Minimal, Bounce, Classic) with kinetic typography
- **Intelligent B-Roll** - Content-aware background video insertion with keyword mapping, library lookup, and synthetic fallback
- **Professional Export** - 1080×1920 vertical video output (h264/aac) with captions, SFX, and normalized audio
- **Web Interface** - Interactive dashboard for project management and clip processing
- **API-First** - RESTful API for programmatic access and integrations

## Architecture

```
apps/
├── api/          # Fastify/TypeScript backend with FFmpeg processing
└── web/          # Next.js frontend dashboard
```

### Pipeline Flow
1. Upload video → 2. Transcribe & analyze → 3. Detect scenes/clips → 
4. Generate captions (6 styles) → 5. Insert B-roll/SFX → 6. Render export

## Quick Start

### Prerequisites
- Node.js 18+
- FFmpeg 6+
- Python 3.10+ (for faster-whisper, optional)
- yt-dlp (for YouTube imports)

### Setup

```bash
# Clone the repository
git clone https://github.com/clipuni34-coder/Syntheniq.git
cd Syntheniq

# Install API dependencies
cd apps/api
npm install

# Install Web dependencies
cd ../web
npm install

# Configure environment
cd ../api
cp .env.example .env.local
# Edit .env.local with your settings

# Start API server
PORT=8788 node dist/server.js

# Build and serve web app (or use dev server)
npm run dev
```

## Environment Variables

### API (`apps/api/.env.example`)
Key settings:
- `OPENAI_API_KEY` - For Whisper transcription (optional)
- `OPENAI_EDITORIAL_KEY` - For AI clip ranking (optional)
- `PORT` - Server port (default: 8788)
- `MAX_UPLOAD_MB` - File upload limit (default: 2048)
- `WHISPER_MODEL` - Local model: tiny, base, small, medium, etc.

### Web (`apps/web/.env.example`)
- `NEXT_PUBLIC_API_URL` - API endpoint (auto-detected in Codespaces)

## Deployment

See `scripts/deploy.sh` for Fly.io or Render.com deployment instructions.