#!/usr/bin/env python3
"""Syntheniq — local transcription worker (faster-whisper).

Reads a 16kHz mono WAV file, prints a single JSON document to stdout:
  {"segments": [{"start","end","text","words":[{"start","end","word"}]}], ...}

All logging goes to stderr so stdout stays machine-readable.
"""
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--language", default=None)
    parser.add_argument("--offset", type=float, default=0.0)
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster_whisper is not installed", file=sys.stderr)
        return 2

    model = WhisperModel(args.model, device=args.device, compute_type="int8")
    segments_iter, info = model.transcribe(
        args.input,
        language=args.language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        condition_on_previous_text=False,
    )

    segments = []
    for seg in segments_iter:
        words = []
        for w in seg.words or []:
            words.append(
                {
                    "start": round(w.start + args.offset, 3),
                    "end": round(w.end + args.offset, 3),
                    "word": w.word,
                }
            )
        segments.append(
            {
                "start": round(seg.start + args.offset, 3),
                "end": round(seg.end + args.offset, 3),
                "text": (seg.text or "").strip(),
                "words": words,
            }
        )

    json.dump(
        {
            "segments": segments,
            "language": getattr(info, "language", None),
            "language_probability": getattr(info, "language_probability", None),
            "duration": getattr(info, "duration", None),
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
