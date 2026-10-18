// Generates clean PCM WAV files for SFX assets.
// Run: node scripts/gen-sfx-assets.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SAMPLE_RATE = 48000;
const BITS = 16;
const CHANNELS = 1;
const OUT_DIR = join(import.meta.url.replace(/^file:\/\//, ''), '..', 'sfx_assets').replace(/\/scripts$/, '');

// resolve OUT_DIR properly
const outDir = join(process.cwd(), 'sfx_assets');
import { mkdirSync } from 'node:fs';
mkdirSync(outDir, { recursive: true });

function makeWav(samples, outFile) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  const dataSize = samples.length * 2;
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS / 8);
  const blockAlign = CHANNELS * (BITS / 8);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(BITS, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
  }

  writeFileSync(outFile, buf);
}

function sine(frequency, duration, amp) {
  amp = amp || 0.7;
  const n = Math.floor(duration * SAMPLE_RATE);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    out.push(amp * Math.sin(2 * Math.PI * frequency * t));
  }
  return out;
}

function noise(duration, color, amp) {
  amp = amp || 0.7;
  const n = Math.floor(duration * SAMPLE_RATE);
  const out = [];
  let rng = 12345;
  const rand = function() {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return (rng / 0x7fffffff) * 2 - 1;
  };
  let pink_acc = 0;
  let brown_acc = 0.1;
  for (let i = 0; i < n; i++) {
    let v;
    if (color === 'white') {
      v = rand();
    } else if (color === 'pink') {
      pink_acc += rand() * 0.03;
      const white = rand();
      v = white * 0.3 + pink_acc * 0.7;
    } else {
      brown_acc += rand() * 0.01;
      brown_acc = Math.max(-0.9, Math.min(0.9, brown_acc));
      v = brown_acc;
    }
    out.push(amp * v);
  }
  return out;
}

function fadeOut(samples, fadeDur) {
  const n = samples.length;
  const fadeSamples = Math.min(n, Math.floor(fadeDur * SAMPLE_RATE));
  for (let i = 0; i < n; i++) {
    if (i >= n - fadeSamples) {
      const fadeProg = (i - (n - fadeSamples)) / fadeSamples;
      samples[i] *= 1 - fadeProg;
    }
  }
  return samples;
}

function fadeIn(samples, fadeDur) {
  const fadeSamples = Math.floor(fadeDur * SAMPLE_RATE);
  for (let i = 0; i < Math.min(samples.length, fadeSamples); i++) {
    samples[i] *= i / fadeSamples;
  }
  return samples;
}

function envelope(samples, attack, decay) {
  const sr = SAMPLE_RATE;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sr;
    const totalDur = samples.length / sr;
    let env = 1;
    if (t < attack) env = t / attack;
    if (t > totalDur - decay && decay > 0) env = Math.max(0, 1 - (t - (totalDur - decay)) / decay);
    samples[i] *= env;
  }
  return samples;
}

function sweep(startFreq, endFreq, duration, amp, color) {
  amp = amp || 0.7;
  const n = Math.floor(duration * SAMPLE_RATE);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const f = startFreq + (endFreq - startFreq) * (t / duration);
    if (color === 'sine') {
      out.push(amp * Math.sin(2 * Math.PI * f * t));
    } else {
      out.push(amp * Math.sin(2 * Math.PI * f * t) * 0.3 + amp * Math.sin(2 * Math.PI * f * 0.5 * t) * 0.7);
    }
  }
  return out;
}

// 14 WAV files across 10 types
const assets = [
  // whoosh - 2 variants
  { name: 'whoosh_1', samples: fadeOut(sweep(200, 1200, 1.5, 0.6, 'noise'), 0.4) },
  { name: 'whoosh_2', samples: fadeOut(sweep(100, 800, 2.0, 0.5, 'noise'), 0.3) },
  // swoosh
  { name: 'swoosh', samples: fadeIn(fadeOut(noise(0.5, 'pink', 0.5), 0.3), 0.1) },
  // pop - 2 variants
  { name: 'pop', samples: envelope(sine(660, 0.15, 0.8), 0.01, 0.14) },
  { name: 'pop_hard', samples: envelope(sine(440, 0.2, 0.9), 0.005, 0.19) },
  // click
  { name: 'click', samples: envelope(sine(1200, 0.05, 0.6), 0.002, 0.048) },
  // hum
  { name: 'hum', samples: envelope(sine(110, 3.0, 0.4), 0.2, 0.2) },
  // tone
  { name: 'tone', samples: envelope(sine(440, 1.0, 0.5), 0.05, 0.05) },
  // impact - 2 variants
  { name: 'impact', samples: fadeOut(noise(0.15, 'white', 0.8), 0.1) },
  { name: 'impact_soft', samples: fadeOut(noise(0.1, 'white', 0.5), 0.05) },
  // footsteps - 2 variants
  { name: 'footsteps', samples: (function() {
    const out = [];
    const stepDur = 0.08;
    const gap = 0.12;
    for (let step = 0; step < 8; step++) {
      const t = step * (stepDur + gap);
      const click = envelope(sine(220, stepDur, 0.5), 0.005, 0.06);
      const offset = Math.floor(t * SAMPLE_RATE);
      while (out.length < offset) out.push(0);
      out.push.apply(out, click);
    }
    return out;
  })() },
  { name: 'footsteps_alt', samples: (function() {
    const out = [];
    const stepDur = 0.06;
    const gap = 0.1;
    for (let step = 0; step < 10; step++) {
      const t = step * (stepDur + gap);
      const click = envelope(sine(330, stepDur, 0.4), 0.003, 0.04);
      const offset = Math.floor(t * SAMPLE_RATE);
      while (out.length < offset) out.push(0);
      out.push.apply(out, click);
    }
    return out;
  })() },
  // cheer - 2 variants
  { name: 'cheer', samples: (function() {
    const n = Math.floor(2.0 * SAMPLE_RATE);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const f = 440 + t * 220;
      const vib = 1 + Math.sin(2 * Math.PI * 5 * t) * 0.3;
      out.push(0.4 * Math.sin(2 * Math.PI * f * t) * vib);
    }
    return fadeIn(fadeOut(out, 0.3), 0.1);
  })() },
  { name: 'cheer_short', samples: (function() {
    const n = Math.floor(1.5 * SAMPLE_RATE);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const f = 523 + t * 110;
      out.push(0.5 * Math.sin(2 * Math.PI * f * t));
    }
    return fadeIn(fadeOut(out, 0.3), 0.1);
  })() },
  // swish
  { name: 'swish', samples: fadeIn(fadeOut(noise(0.6, 'pink', 0.5), 0.3), 0.05) },
];

console.log('Generating ' + assets.length + ' WAV files in ' + outDir + '/');
for (let i = 0; i < assets.length; i++) {
  const asset = assets[i];
  const out = join(outDir, asset.name + '.wav');
  makeWav(asset.samples, out);
  console.log('  ' + asset.name + '.wav (' + (asset.samples.length / SAMPLE_RATE).toFixed(2) + 's, ' + asset.samples.length + ' samples)');
}
console.log('Done.');
