#!/usr/bin/env python3
"""Syntheniq local transcription worker — faster-whisper with word timestamps.

Usage:
  python3 whisper_transcribe.py --wav audio.wav --model small --out transcript.json [--beam 1] [--no-vad]

Prints progress on stderr; writes JSON:
  {"language": "en", "segments": [{"start":s,"end":e,"text":t,"words":[{"start":s,"end":e,"word":w}]}]}
"""
import argparse
import json
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--model", default="small")
    ap.add_argument("--out", required=True)
    ap.add_argument("--beam", type=int, default=1)
    ap.add_argument("--no-vad", action="store_true")
    args = ap.parse_args()

    t0 = time.time()
    sys.stderr.write(f"[whisper] loading model '{args.model}' ...\n")
    sys.stderr.flush()
    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    t1 = time.time()
    sys.stderr.write(f"[whisper] model ready in {t1 - t0:.1f}s, transcribing...\n")
    sys.stderr.flush()

    segments, info = model.transcribe(
        args.wav,
        beam_size=args.beam,
        word_timestamps=True,
        vad_filter=not args.no_vad,
        vad_parameters={"min_silence_duration_ms": 400, "speech_pad_ms": 120},
    )

    out_segments = []
    for seg in segments:
        words = []
        for w in seg.words or []:
            words.append(
                {
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "word": w.word.strip(),
                }
            )
        out_segments.append(
            {
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text.strip(),
                "words": words,
            }
        )
        sys.stderr.write(f"[whisper]   {seg.start:7.1f}s -> {seg.end:7.1f}s  {seg.text[:60]!r}\n")
        sys.stderr.flush()

    result = {
        "language": info.language,
        "duration": info.duration,
        "segments": out_segments,
    }
    with open(args.out, "w") as f:
        json.dump(result, f)
    sys.stderr.write(f"[whisper] done in {time.time() - t1:.1f}s ({len(out_segments)} segments)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
