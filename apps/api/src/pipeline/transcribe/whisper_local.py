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

    # Compatibility shim: faster-whisper 1.2.1 forwards metadata_errors="ignore"
    # to av.open(), a keyword that current PyAV (>=14) no longer accepts and
    # raises TypeError on. Wrap av.open to drop that kwarg so transcription runs
    # across PyAV versions. It only controls metadata parsing robustness, which
    # is irrelevant for a clean 16kHz WAV input.
    try:
        import av as _av
        if not getattr(_av, "_syntheniq_patched", False):
            _orig_av_open = _av.open

            def _av_open(*args, **kwargs):
                kwargs.pop("metadata_errors", None)
                return _orig_av_open(*args, **kwargs)

            _av.open = _av_open
            _av._syntheniq_patched = True
    except Exception:
        pass

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
