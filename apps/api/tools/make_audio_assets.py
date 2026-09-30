#!/usr/bin/env python3
"""Generate Syntheniq's bundled audio assets (music beds + SFX).

Deterministic, dependency-light (numpy only). Output: m4a (AAC) files under
apps/api/assets/audio/{beds,sfx}/. Run once; the generated files are committed
so renders never depend on regeneration.

  python3 make_audio_assets.py
"""
import math
import os
import subprocess
import sys

try:
    import numpy as np
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "numpy"])
    import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio")


def save_wav(path, x, sr=SR):
    x = np.clip(x, -1, 1)
    import wave

    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((x * 32767).astype("<i2").tobytes())


def tone(freq, dur, sr=SR, decay=6.0, kind="sine", detune=1.0):
    t = np.arange(int(sr * dur)) / sr
    if kind == "sine":
        x = np.sin(2 * np.pi * freq * t) * 0.5 + np.sin(2 * np.pi * freq * detune * t) * 0.25
    elif kind == "tri":
        x = (2 / np.pi) * np.arcsin(np.sin(2 * np.pi * freq * t)) * 0.4
    else:  # square-ish
        x = np.sign(np.sin(2 * np.pi * freq * t)) * 0.25
    x *= np.exp(-decay * t)
    return x


def noise(dur, sr=SR):
    return np.random.default_rng(7).uniform(-1, 1, int(sr * dur))


def env(x, attack=0.01, release=0.05):
    n = len(x)
    a = max(1, int(sr_to_n(attack)))
    r = max(1, int(sr_to_n(release)))
    e = np.ones(n)
    e[:a] = np.linspace(0, 1, a)
    e[-r:] *= np.linspace(1, 0, r)
    return x * e


def sr_to_n(sec):
    return int(sec * SR)


def sweep(f0, f1, dur, amp=1.0, decay=0.0):
    """Stable phase-accumulated sine sweep f0 -> f1 Hz over dur seconds."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    f = np.linspace(f0, f1, n)
    phase = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(phase) * amp
    if decay > 0:
        x *= np.exp(-decay * t)
    return x


def bed_chill(dur=90.0, bpm=72.0):
    """Warm ambient pad: Am – F – C – G, slow attack, subtle sub bass."""
    chords = [[220.0, 261.63, 329.63], [174.61, 220.0, 261.63],
              [130.81, 196.0, 261.63], [196.0, 246.94, 293.66]]
    beat = 60.0 / bpm
    bar = beat * 4
    n = int(SR * dur)
    x = np.zeros(n)
    i = 0
    t0 = 0.0
    while t0 < dur:
        ch = chords[i % 4]
        for f in ch:
            seg = tone(f, bar * 1.1, decay=0.55)
            s = int(SR * t0)
            e = min(n, s + len(seg))
            seg = seg[: e - s]
            fade = min(len(seg), sr_to_n(1.2))
            seg[:fade] *= np.linspace(0, 1, fade) ** 2
            seg[-fade:] *= np.linspace(1, 0, fade) ** 2
            x[s:e] += seg * 0.16
        sub = tone(ch[0] / 2, bar * 1.1, decay=0.8, kind="tri")
        s = int(SR * t0)
        e = min(n, s + len(sub))
        sub = sub[: e - s]
        x[s:e] += sub * 0.2
        t0 += bar
        i += 1
    # gentle air layer
    air = noise(dur) * 0.008
    x += air * env(air)
    return x * 0.9


def bed_drive(dur=90.0, bpm=112.0):
    """Subtle drive: Em – C – G – D pad + soft four-on-floor kick + hat ticks."""
    chords = [[164.81, 196.0, 246.94], [130.81, 196.0, 261.63],
              [196.0, 246.94, 293.66], [146.83, 196.0, 246.94]]
    beat = 60.0 / bpm
    bar = beat * 4
    n = int(SR * dur)
    x = np.zeros(n)
    i = 0
    t0 = 0.0
    while t0 < dur:
        ch = chords[i % 4]
        for f in ch:
            seg = tone(f, bar * 1.05, decay=0.7)
            s = int(SR * t0)
            e = min(n, s + len(seg))
            seg = seg[: e - s]
            fade = min(len(seg), sr_to_n(0.5))
            seg[:fade] *= np.linspace(0, 1, fade) ** 2
            seg[-fade:] *= np.linspace(1, 0, fade) ** 2
            x[s:e] += seg * 0.14
        for b in range(4):
            kt = t0 + b * beat
            if kt >= dur:
                break
            kick = tone(52.0, 0.22, decay=22.0)
            s = int(SR * kt)
            e = min(n, s + len(kick))
            x[s:e] += kick[: e - s] * 0.30
            hat = noise(0.05) * np.exp(-60 * np.arange(int(SR * 0.05)) / SR)
            s2 = int(SR * (kt + beat / 2))
            e2 = min(n, s2 + len(hat))
            x[s2:e2] += hat[: e2 - s2] * 0.05
        t0 += bar
        i += 1
    return x * 0.85


def sfx_whoosh(dur=0.5):
    t = np.arange(int(SR * dur)) / dur
    x = noise(dur) * (0.25 + 0.75 * t) * np.linspace(1, 0, int(SR * dur)) ** 1.2
    s = sweep(300, 2600, dur, amp=0.25)
    return (x * 0.5 + s) * 0.6


def sfx_pop(dur=0.14):
    t = np.arange(int(SR * dur)) / SR
    f = 620 - 470 * (t / dur) ** 1.5
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-28 * t)
    return x * 0.7


def sfx_riser(dur=1.2):
    t = np.arange(int(SR * dur)) / dur
    x = noise(dur) * (0.2 + 0.8 * t)
    s = sweep(180, 720, dur, amp=0.15)
    ramp = np.linspace(0, 1, int(SR * dur)) ** 0.6
    return (x * 0.35 + s * t) * ramp


def sfx_hit(dur=0.45):
    t = np.arange(int(SR * dur)) / SR
    f = 85 * np.exp(-6 * t) + 30
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-9 * t) * 0.8
    n = noise(0.12) * np.exp(-40 * np.arange(int(SR * 0.12)) / SR) * 0.25
    out = np.zeros(int(SR * dur))
    out[: len(n)] += n
    out += x
    return out


def to_m4a(wav, m4a):
    subprocess.check_call(
        ["ffmpeg", "-y", "-v", "error", "-i", wav, "-c:a", "aac", "-b:a", "160k", m4a]
    )


def main():
    os.makedirs(os.path.join(OUT, "beds"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "sfx"), exist_ok=True)
    jobs = [
        ("beds/bed_chill", bed_chill()),
        ("beds/bed_drive", bed_drive()),
        ("sfx/whoosh", sfx_whoosh()),
        ("sfx/pop", sfx_pop()),
        ("sfx/riser", sfx_riser()),
        ("sfx/hit", sfx_hit()),
    ]
    for name, x in jobs:
        wav = os.path.join(OUT, name + ".wav")
        m4a = os.path.join(OUT, name + ".m4a")
        save_wav(wav, x)
        to_m4a(wav, m4a)
        os.remove(wav)
        print(f"wrote {m4a}")


if __name__ == "__main__":
    main()
