# Syntheniq product spec

## Core promise
Upload one long video. Syntheniq decides what is worth clipping, why it is worth clipping, how it should be packaged, and produces finished short-form exports.

## First workflow
1. Upload
2. Validate media
3. Extract audio
4. Transcribe with timestamps
5. Inspect transcript/video alignment
6. Score candidate moments
7. Produce edit decision list
8. Render 9:16
9. Run export QC
10. Generate thumbnail + title + caption + hashtags
11. Download package

## Editorial score
- Hook: 25%
- Curiosity: 20%
- Payoff: 20%
- Standalone clarity: 15%
- Emotion/energy: 10%
- Visual quality: 10%

Two layers produce these scores. The deterministic heuristic always runs
(free, instant, offline) and every clip keeps its heuristic scores. When an
OpenAI key is configured, an LLM editor re-scores the top candidates with
full transcript context plus measured video signals (scene cuts, speech
ratio, energy variance), with one grounded evidence phrase per dimension.
Each clip records which layer decided it; any LLM failure keeps the
heuristic ranking — the editor is an upgrade, never a dependency.

## Non-negotiable
The transcript is not the final authority. The video is. If transcript coverage ends before the media duration, the job is incomplete and must be reprocessed.
