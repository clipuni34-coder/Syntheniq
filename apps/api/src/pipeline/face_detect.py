#!/usr/bin/env python3
"""Frontal-face detector backed by the bundled OpenCV Haar cascade.

Invoked once per frame by the pipeline (see src/pipeline/render/faces.ts):

    python3 face_detect.py <frame.jpg> --min_confidence 0.2

Prints a single JSON object to stdout describing every accepted detection:

    {"faces": [{"x":0,"y":0,"width":1,"height":1,"confidence":0.0}]}

All diagnostic output goes to stderr so stdout stays parseable by the caller.
The cascade XML lives next to this script (src/pipeline/face_detect_cascade.xml)
and is copied alongside it during `npm run build`, so the relative lookup works
in both source and compiled (dist) runs.
"""
import argparse
import json
import math
import os
import sys

import cv2


CASCADE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'face_detect_cascade.xml'
)


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def detect(frame_path: str, min_confidence: float = 0.2) -> dict:
    cascade = cv2.CascadeClassifier(CASCADE_PATH)
    if cascade.empty():
        print(f'face_detect: failed to load cascade at {CASCADE_PATH}', file=sys.stderr)
        sys.exit(1)

    img = cv2.imread(frame_path)
    if img is None:
        print(f'face_detect: could not read image at {frame_path}', file=sys.stderr)
        sys.exit(1)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # detectMultiScale3 returns (rects, rejectLevels, levelWeights). We only need
    # the rectangles and their per-detection confidence weights.
    result = cascade.detectMultiScale3(
        gray,
        scaleFactor=1.1,
        minNeighbors=3,
        minSize=(30, 30),
        flags=cv2.CASCADE_SCALE_IMAGE,
        outputRejectLevels=True,
    )

    if len(result) == 3:
        rects, _reject_levels, weights = result
    else:
        # Older bindings may omit reject levels; fall back gracefully.
        rects = result
        weights = [0.0] * len(rects)

    faces = []
    for (x, y, w, h), weight in zip(rects, weights):
        confidence = _sigmoid(float(weight))
        if confidence >= min_confidence:
            faces.append({
                'x': int(x),
                'y': int(y),
                'width': int(w),
                'height': int(h),
                'confidence': round(confidence, 3),
            })

    return {'faces': faces}


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Detect frontal faces in a single image frame.'
    )
    parser.add_argument('image', help='Path to the input image frame.')
    parser.add_argument(
        '--min_confidence',
        type=float,
        default=0.2,
        help='Minimum confidence (0-1) for a detection to be kept.',
    )
    args = parser.parse_args()

    print(json.dumps(detect(args.image, args.min_confidence)))


if __name__ == '__main__':
    main()
