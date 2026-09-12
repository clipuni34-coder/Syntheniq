# Syntheniq

AI video editing that understands the story.

## MVP
Upload a video → analyze/transcribe → rank moments → create edit decisions → render 9:16 clips → export MP4 + thumbnail + posting metadata.

## Architecture
- Web: Next.js/React
- API: Node.js/TypeScript
- AI: OpenAI Responses API + transcription API
- Rendering: FFmpeg first, Remotion for advanced graphics
- Storage: S3-compatible object storage (Cloudflare R2 in production)
- Queue: Redis/BullMQ in production
- Database: Postgres/Supabase in production

## Current development mode
This repository starts as a local-first vertical slice. No API keys are committed.
