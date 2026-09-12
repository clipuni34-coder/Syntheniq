// Syntheniq — video structure analysis: scene cuts, speech-active
// intervals, and a loudness/energy curve computed from PCM in Node.
import fs from 'node:fs';
import { run } from '../lib/ffmpeg.js';
import type { EnergyPoint, Span, StructureData } from '../types.js';

export async function detectSilences(
  wavPath: string,
  { noiseDb = -32, minDuration = 0.35 }: { noiseDb?: number; minDuration?: number } = {}
): Promise<Span[]> {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-i',
    wavPath,
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
    '-f',
    'null',
    '-',
  ]);
  const silences: Span[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split('\n')) {
    let m = line.match(/silence_start:\s*([0-9.]+)/);
    if (m) {
      pendingStart = parseFloat(m[1]);
      continue;
    }
    m = line.match(/silence_end:\s*([0-9.]+)/);
    if (m && pendingStart !== null) {
      silences.push({ start: pendingStart, end: parseFloat(m[1]) });
      pendingStart = null;
    }
  }
  if (pendingStart !== null) silences.push({ start: pendingStart, end: Infinity });
  return silences;
}

export function speechFromSilences(
  silences: Span[],
  duration: number,
  { mergeGap = 0.9, minSpeech = 0.5 }: { mergeGap?: number; minSpeech?: number } = {}
): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  const bounded = silences
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(duration, s.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  for (const s of bounded) {
    if (s.start > cursor) spans.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) spans.push({ start: cursor, end: duration });

  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end <= mergeGap) last.end = s.end;
    else merged.push({ ...s });
  }
  return merged.filter((s) => s.end - s.start >= minSpeech);
}

export async function detectSpeech(wavPath: string, duration: number, opts = {}): Promise<Span[]> {
  const silences = await detectSilences(wavPath, opts);
  return speechFromSilences(silences, duration, opts);
}

export async function detectSceneCuts(videoPath: string, threshold = 0.35): Promise<number[]> {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-i',
    videoPath,
    '-vf',
    `select='gt(scene,${threshold})',showinfo`,
    '-f',
    'null',
    '-',
  ]);
  const cuts: number[] = [];
  for (const line of stderr.split('\n')) {
    const m = line.match(/pts_time:([0-9.]+)/);
    if (m) cuts.push(parseFloat(m[1]));
  }
  return cuts.sort((a, b) => a - b);
}

// Streaming PCM reader: parses the WAV header from the first bytes, then
// streams the data chunk in fixed windows. Memory stays flat (~a few MB)
// no matter how long the video is — a 3-hour upload must not OOM the worker.
function parseWavHeader(wavPath: string): { dataOffset: number; dataSize: number; channels: number; sampleRate: number } {
  const fd = fs.openSync(wavPath, 'r');
  try {
    const head = Buffer.alloc(65536);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, n);
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
      throw new Error('Unsupported audio file for energy analysis (expected WAV)');
    }
    let channels = 1;
    let sampleRate = 16000;
    let bitsPerSample = 16;
    let dataOffset = -1;
    let dataSize = 0;
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') {
        channels = buf.readUInt16LE(off + 10);
        sampleRate = buf.readUInt32LE(off + 12);
        bitsPerSample = buf.readUInt16LE(off + 22);
      } else if (id === 'data') {
        dataOffset = off + 8;
        dataSize = size;
        break;
      }
      off += 8 + size + (size % 2);
    }
    if (dataOffset < 0) throw new Error('WAV data chunk not found');
    if (bitsPerSample !== 16) throw new Error(`Unsupported bit depth: ${bitsPerSample}`);
    return { dataOffset, dataSize, channels, sampleRate };
  } finally {
    fs.closeSync(fd);
  }
}

export async function computeEnergyCurve(
  wavPath: string,
  { windowSeconds = 0.5, maxPoints = 2400 }: { windowSeconds?: number; maxPoints?: number } = {}
): Promise<EnergyPoint[]> {
  const { dataOffset, dataSize, channels, sampleRate } = parseWavHeader(wavPath);
  const frameBytes = channels * 2;
  const totalFrames = Math.floor(Math.min(dataSize, Math.max(0, fs.statSync(wavPath).size - dataOffset)) / frameBytes);
  const window = Math.max(1, Math.floor(sampleRate * windowSeconds));

  const buckets: EnergyPoint[] = [];
  let frame = 0; // absolute frame index into the PCM stream
  let sum = 0; // sum of squared mono samples in the open window
  let winStart = 0; // absolute frame index where the open window started
  let winCount = 0;
  let carry = Buffer.alloc(0);

  const flushWindow = () => {
    const rms = Math.sqrt(sum / Math.max(1, winCount));
    buckets.push({
      t: Math.round((winStart / sampleRate) * 1000) / 1000,
      rms: Math.round(rms * 1000) / 1000,
    });
  };

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(wavPath, { start: dataOffset });
    stream.on('error', reject);
    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.concat([carry, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const usable = buf.length - (buf.length % frameBytes);
      carry = buf.subarray(usable);
      for (let off = 0; off < usable && frame < totalFrames; off += frameBytes, frame++) {
        let acc = 0;
        for (let c = 0; c < channels; c++) acc += buf.readInt16LE(off + c * 2);
        const mono = acc / channels / 32768;
        sum += mono * mono;
        winCount++;
        if (winCount >= window) {
          flushWindow();
          sum = 0;
          winCount = 0;
          winStart = frame + 1;
        }
      }
    });
    stream.on('end', () => {
      if (winCount > 0) flushWindow();
      resolve();
    });
  });

  if (buckets.length <= maxPoints) return buckets;
  const factor = buckets.length / maxPoints;
  const out: EnergyPoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const from = Math.floor(i * factor);
    const to = Math.min(buckets.length, Math.floor((i + 1) * factor));
    let sumRms = 0;
    for (let j = from; j < to; j++) sumRms += buckets[j].rms;
    out.push({
      t: buckets[from].t,
      rms: Math.round((sumRms / Math.max(1, to - from)) * 1000) / 1000,
    });
  }
  return out;
}

export async function analyzeStructure(
  videoPath: string,
  wavPath: string,
  duration: number
): Promise<StructureData> {
  const [sceneCuts, speechActive] = await Promise.all([
    detectSceneCuts(videoPath).catch((): number[] => []),
    detectSpeech(wavPath, duration).catch((): Span[] => []),
  ]);
  let energyCurve: EnergyPoint[] = [];
  try {
    energyCurve = await computeEnergyCurve(wavPath);
  } catch {
    energyCurve = [];
  }
  const speechSeconds = speechActive.reduce((a, s) => a + (s.end - s.start), 0);
  const meanEnergy =
    energyCurve.length > 0
      ? energyCurve.reduce((a, p) => a + p.rms, 0) / energyCurve.length
      : 0;
  return {
    sceneCuts,
    speechActive,
    energyCurve,
    stats: {
      cutCount: sceneCuts.length,
      speechRatio: duration > 0 ? Math.min(1, speechSeconds / duration) : 0,
      meanEnergy: Math.round(meanEnergy * 1000) / 1000,
    },
  };
}
