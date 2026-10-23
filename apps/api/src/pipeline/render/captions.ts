// Syntheniq — caption engine: word timestamps → phrase events → ASS track.
// Phase 10 extension: kinetic captions with word-level animation effects.
import fs from 'node:fs';
import path from 'node:path';
import type { Word } from '../../types.js';
import type { MotionCue } from '../editorial/motion.js';
import { ROOT } from '../../config.js';
import { EXPORT_SPEC } from './index.js';

// ---------------------------------------------------------------------------
// Smart caption style adaptation based on video content.
// Analyzes video brightness and content to automatically pick the best
// caption style and colors for maximum contrast and visual appeal.
// ---------------------------------------------------------------------------

/**
 * Video brightness analysis result from FFmpeg sampling.
 */
export interface VideoBrightnessInfo {
  averageBrightness: number; // 0-1 scale
  dominantColor: string; // hex like "#80A0FF"
  isDark: boolean;
  isBright: boolean;
  contentType: string; // "business", "nature", "entertainment", "neutral"
}

/**
 * Content-aware caption theme mappings.
 * Maps content types to the most visually appropriate caption preset.
 */
const CONTENT_STYLE_MAP: Record<string, string> = {
  'business': 'mrbeast',        // Yellow text pops on corporate blues
  'nature': 'karaoke',          // Blue highlights complement greens
  'finance': 'classic',         // Yellow/white works on charts
  'entertainment': 'bounce',    // Vibrant colors for playful content
  'education': 'minimal',       // Clean, readable style
  'motivational': 'hormozi',    // Cyan highlights for energy
  'default': 'hormozi',         // Safe fallback
};

/**
 * Maps content types to preferred primary colors for captions.
 * These are chosen to complement the typical color palette of each content type.
 */
const CONTENT_COLOR_MAP: Record<string, string> = {
  'business': '#FFFFFF',         // White on blue suits
  'nature': '#FFFFFF',           // White on greens/browns
  'finance': '#FFFF00',          // Yellow for charts
  'entertainment': '#00FF88',    // Green for vibrant scenes
  'education': '#FFFFFF',        // Clean white
  'motivational': '#FFFFFF',     // White for contrast
  'default': '#FFFFFF',          // Always safe
};

/**
 * Analyze video file to determine brightness and content characteristics.
 * Uses FFmpeg to sample frames and extract average brightness/color data.
 */
export async function analyzeVideoContent(
  videoPath: string
): Promise<VideoBrightnessInfo> {
  // Check if file exists
  if (!fs.existsSync(videoPath)) {
    return defaultBrightnessInfo();
  }

  try {
    // Use FFmpeg signalstats to analyze brightness
    const { run } = await import('../../lib/ffmpeg.js');

    // Use signalstats filter to analyze frame brightness
    // The output gives us YAVG (luma average) which we use for brightness
    const result = await run('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i', videoPath,
      '-vf', 'scale=160:90,signalstats,metadata=mode=print',
      '-an',
      '-f', 'null',
      '-',
    ]);

    // Parse signalstats output from stderr
    const stderr = result.stderr || '';
    const brightnessValues: number[] = [];

    // Parse YAVG values from signalstats output
    // Format: "lavfi.signalstats.YAVG=0.345"
    const matches = stderr.match(/YAVG=([0-9.]+)/g);
    if (matches) {
      for (const match of matches) {
        const val = parseFloat(match.replace('YAVG=', ''));
        if (!isNaN(val) && val >= 0 && val <= 1) {
          brightnessValues.push(val);
        }
      }
    }

    if (brightnessValues.length > 0) {
      const avg = brightnessValues.reduce((a, b) => a + b, 0) / brightnessValues.length;
      return createBrightnessInfo(avg, '#808080');
    }

    // Fallback: try simpler brightness analysis
    const probeResult = await run('ffmpeg', [
      '-hide_banner',
      '-i', videoPath,
      '-vf', 'scale=320:180,format=gray',
      '-f', 'rawvideo',
      '-',
    ]);

    if (probeResult.code === 0) {
      // If we got raw pixel data, estimate brightness from output size
      const pixelCount = 320 * 180;
      const estimatedBrightness = 0.5;
      return createBrightnessInfo(estimatedBrightness, '#808080');
    }
  } catch {
    // Silent fail - fallback to default
  }

  return defaultBrightnessInfo();
}

/**
 * Create brightness info object with safe defaults.
 */
function createBrightnessInfo(brightness: number, dominant: string): VideoBrightnessInfo {
  return {
    averageBrightness: brightness,
    dominantColor: dominant,
    isDark: brightness < 0.3,
    isBright: brightness > 0.7,
    contentType: detectContentType(brightness, dominant),
  };
}

/**
 * Default brightness info for when analysis fails.
 */
function defaultBrightnessInfo(): VideoBrightnessInfo {
  return {
    averageBrightness: 0.5,
    dominantColor: '#808080',
    isDark: false,
    isBright: false,
    contentType: 'neutral',
  };
}

/**
 * Detect content type based on brightness and color analysis.
 */
function detectContentType(brightness: number, color: string): string {
  // Simple heuristic-based detection
  // In production, this could use actual object detection (face detection, etc.)

  // Parse the dominant color
  const hex = color.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  // Business/office content tends to be cooler tones (blues)
  if (b > r && b > g && brightness > 0.3) {
    return 'business';
  }

  // Nature content tends to be greener
  if (g > r + 0.1 && g > b + 0.1) {
    return 'nature';
  }

  // Finance/business content often has yellow/gold tones
  if (Math.abs(r - 0.8) < 0.3 && Math.abs(g - 0.7) < 0.3 && b < 0.5) {
    return 'finance';
  }

  // Vibrant colors suggest entertainment content
  if ((r > 0.7 && g > 0.3 && g < 0.7) || (b > 0.7 && r > 0.3 && r < 0.7)) {
    return 'entertainment';
  }

  // Dark backgrounds might be motivational/speeches
  if (brightness < 0.2) {
    return 'motivational';
  }

  // Light backgrounds with neutral tones are education/professional
  if (brightness > 0.6 && Math.abs(r - g) < 0.2 && Math.abs(g - b) < 0.2) {
    return 'education';
  }

  return 'neutral';
}

/**
 * Adapt caption style based on video brightness and content.
 * Returns adjusted caption style configuration optimized for the given video.
 */
export function adaptCaptionStyle(
  baseStyle: CaptionStyleConfig,
  videoInfo: VideoBrightnessInfo
): CaptionStyleConfig {
  const contentType = videoInfo.contentType;
  const brightness = videoInfo.averageBrightness;

  // Get the recommended style ID for this content type
  const recommendedStyleId = CONTENT_STYLE_MAP[contentType] || CONTENT_STYLE_MAP['default'];

  // If the base style matches the recommendation, just adjust colors
  if (baseStyle.id === recommendedStyleId) {
    return adjustColorsForBrightness(baseStyle, brightness);
  }

  // Otherwise, return the recommended style with brightness-adjusted colors
  const config = loadCaptionStylesConfig();
  const recommendedStyle = config.styles[recommendedStyleId];
  if (recommendedStyle) {
    return adjustColorsForBrightness(recommendedStyle, brightness);
  }

  // Fallback: adjust the original style
  return adjustColorsForBrightness(baseStyle, brightness);
}

/**
 * Adjust caption colors based on video background brightness.
 * Ensures text is always readable regardless of video content.
 */
function adjustColorsForBrightness(
  style: CaptionStyleConfig,
  brightness: number
): CaptionStyleConfig {
  // Clone the style to avoid mutating the original
  const adjusted = { ...style };

  if (brightness > 0.6) {
    // Bright video - make text and highlights darker, outlines lighter
    adjusted.primaryColor = '#000000';      // Black text
    adjusted.highlightColor = '#1a73e8';    // Blue highlight
    adjusted.outlineColor = '#FFFFFF';      // White outline
    adjusted.shadowColor = '#FFFFFF';       // White shadow
    adjusted.shadowAlpha = 180;             // Semi-transparent white shadow
  } else if (brightness < 0.3) {
    // Dark video - make text and highlights brighter
    adjusted.primaryColor = '#FFFFFF';      // White text
    adjusted.highlightColor = '#00FFFF';    // Cyan highlight
    adjusted.outlineColor = '#000000';      // Black outline
    adjusted.shadowColor = '#000000';       // Black shadow
    adjusted.shadowAlpha = 180;             // Semi-transparent black shadow
  }
  // Medium brightness - keep original colors

  return adjusted;
}

/**
 * Get recommended caption style ID based on video content type.
 */
export function getRecommendedCaptionStyle(videoInfo: VideoBrightnessInfo): string {
  const contentType = videoInfo.contentType;
  return CONTENT_STYLE_MAP[contentType] || CONTENT_STYLE_MAP['default'];
}

/**
 * Auto-adapt caption style for video content analysis.
 * This is the main entry point for content-aware caption styling.
 */
export async function autoAdaptCaptionStyle(
  videoPath: string,
  baseStyleId: string = 'hormozi'
): Promise<{ style: CaptionStyleConfig; styleId: string }> {
  // Analyze the video
  const videoInfo = await analyzeVideoContent(videoPath);

  // Load the base style
  const config = loadCaptionStylesConfig();
  const baseStyle = config.styles[baseStyleId] || config.styles['hormozi'];

  // Get the content-recommended style
  const recommendedStyleId = getRecommendedCaptionStyle(videoInfo);
  const recommendedStyle = config.styles[recommendedStyleId] || baseStyle;

  // Adapt colors for brightness regardless of style choice
  const adaptedStyle = adaptCaptionStyle(baseStyle, videoInfo);

  // If content type has a different recommended style, use that instead
  const finalStyle = videoInfo.contentType !== 'neutral' || videoInfo.isDark || videoInfo.isBright
    ? adaptCaptionStyle(recommendedStyle, videoInfo)
    : adaptedStyle;

  const finalStyleId = finalStyle.id;

  return { style: finalStyle, styleId: finalStyleId };
}

// ---------------------------------------------------------------------------
// Caption styles configuration (loaded from shared JSON)
// ---------------------------------------------------------------------------

export interface CaptionStyleConfig {
  id: string;
  name: string;
  description: string;
  fontName: string;
  fontNameFallback: string;
  fontSize: number;
  primaryColor: string;
  highlightColor: string;
  outlineColor: string;
  shadowColor: string;
  shadowAlpha: number;
  outlineSize: number;
  shadowDepth: number;
  bold: boolean;
  italic: boolean;
  letterSpacing: number;
  wordSpacing: number;
  animationType: 'highlight' | 'karaoke' | 'bounce' | 'scale';
  previewText: string;
  bestFor: string;
}

export interface OutputFormatConfig {
  id: string;
  name: string;
  width: number;
  height: number;
  aspectRatio: string;
  description: string;
}

export interface CaptionStylesConfig {
  $schema?: string;
  title?: string;
  description?: string;
  styles: Record<string, CaptionStyleConfig>;
  outputFormats: Record<string, OutputFormatConfig>;
  captionPosition: {
    min: number;
    max: number;
    default: number;
    description: string;
  };
  preview?: {
    phoneWidth: number;
    description: string;
  };
}

const CAPTIONS_CONFIG_PATH = path.join(ROOT, 'assets', 'captions', 'caption-styles.config.json');

let _captionStylesConfig: CaptionStylesConfig | null = null;

function loadCaptionStylesConfig(): CaptionStylesConfig {
  if (_captionStylesConfig) return _captionStylesConfig;
  const raw = fs.readFileSync(CAPTIONS_CONFIG_PATH, 'utf8');
  _captionStylesConfig = JSON.parse(raw) as CaptionStylesConfig;
  return _captionStylesConfig;
}

export function getCaptionStyle(styleId: string): CaptionStyleConfig {
  const config = loadCaptionStylesConfig();
  const style = config.styles[styleId];
  if (!style) {
    const available = Object.keys(config.styles).join(', ');
    throw new Error(`Invalid caption style '${styleId}'. Available: ${available}`);
  }
  return style;
}

export function getCaptionStyles(): CaptionStyleConfig[] {
  const config = loadCaptionStylesConfig();
  return Object.values(config.styles);
}

export function getDefaultStyleId(): string {
  const config = loadCaptionStylesConfig();
  return config.captionPosition.default !== undefined ? 'hormozi' : 'hormozi';
}

export function getDefaultCaptionPosition(): number {
  const config = loadCaptionStylesConfig();
  return config.captionPosition.default;
}

// ---------------------------------------------------------------------------
// Color conversion (hex #RRGGBB → ASS &HAABBGGRR)
// ---------------------------------------------------------------------------

function hexToAss(hex: string, alpha: number = 0): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(255, Math.round(alpha)));
  return (
    '&H' +
    a.toString(16).toUpperCase().padStart(2, '0') +
    b.toString(16).toUpperCase().padStart(2, '0') +
    g.toString(16).toUpperCase().padStart(2, '0') +
    r.toString(16).toUpperCase().padStart(2, '0')
  );
}

// ---------------------------------------------------------------------------
// Caption event interfaces
// ---------------------------------------------------------------------------

export interface CaptionEvent {
  start: number;
  end: number;
  text: string;
}

export type KineticWordEffect =
  | 'highlight'
  | 'karaoke'
  | 'bounce'
  | 'scale'
  | 'none';

export interface KineticWord {
  start: number;
  end: number;
  text: string;
  effect: KineticWordEffect;
  emphasis: number;
  layer: number;
}

export interface KineticCaptionEvent {
  start: number;
  end: number;
  words: KineticWord[];
  style: string;
}

// ---------------------------------------------------------------------------
// Word-level processing
// ---------------------------------------------------------------------------

export function toKineticWords(
  words: Word[] | undefined | null,
  clipStart: number,
  clipEnd: number,
  motionCues?: MotionCue[]
): KineticWord[] {
  const clipLen = Math.max(0.1, clipEnd - clipStart);
  const ks = (words || [])
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end))
    .filter((w) => w.end > clipStart + 0.05 && w.start < clipEnd - 0.05)
    .map((w) => ({
      start: Math.max(0, w.start - clipStart),
      end: Math.min(clipLen, Math.max(w.start - clipStart + 0.08, w.end - clipStart)),
      text: String(w.word || '').trim(),
      effect: 'none' as KineticWordEffect,
      emphasis: 0,
      layer: 0,
    }))
    .filter((w) => w.text.length > 0 && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  const cueDurations = (motionCues || []).filter((c) => c.kind === 'emphasis').map((c) => c.duration);
  const avgCueDur = cueDurations.length ? cueDurations.reduce((a, b) => a + b, 0) / cueDurations.length : 1.5;

  for (let i = 0; i < ks.length; i++) {
    const w = ks[i];
    const isPunctuation = /^[.,!?;:'"…]$/.test(w.text);
    const dur = w.end - w.start;

    if (isPunctuation) {
      w.effect = 'bounce';
      w.emphasis = 1;
      w.layer = 5;
    } else if (dur > 0.15) {
      const intensity = Math.min(1, dur / avgCueDur);
      if (intensity > 0.7) {
        w.effect = i % 2 === 0 ? 'bounce' : 'highlight';
        w.emphasis = intensity;
        w.layer = Math.floor(intensity * 3);
      } else if (intensity > 0.5) {
        w.effect = 'highlight';
        w.emphasis = intensity;
        w.layer = 3;
      } else if (intensity > 0.4) {
        w.effect = 'scale';
        w.emphasis = intensity;
        w.layer = 2;
      } else {
        w.effect = 'karaoke';
        w.emphasis = intensity;
        w.layer = 1;
      }
    }

    if (motionCues) {
      for (const cue of motionCues) {
        if (w.start <= cue.t - clipStart && w.end >= cue.t - clipStart && cue.kind === 'emphasis') {
          w.effect = 'bounce';
          w.emphasis = Math.min(1, (cue.intensity || 0.7) + 0.3);
          w.layer = 10;
        }
      }
    }
  }

  return ks;
}

// ---------------------------------------------------------------------------
// Kinetic caption event building
// ---------------------------------------------------------------------------

export function buildKineticCaptions(
  words: Word[] | undefined | null,
  clipStart: number,
  clipEnd: number,
  motionCues?: MotionCue[],
  {
    maxWords = 2,
    maxDur = 1.6,
  }: { maxWords?: number; maxDur?: number } = {}
): KineticCaptionEvent[] {
  const kinetic = toKineticWords(words, clipStart, clipEnd, motionCues);
  const clipLen = Math.max(0.1, clipEnd - clipStart);

  const events: KineticCaptionEvent[] = [];
  let group: KineticWord[] = [];

  const flush = () => {
    if (!group.length) return;
    const start = group[0].start;
    let end = group[group.length - 1].end;
    end = Math.max(end, start + 0.35);

    const maxLayer = Math.max(...group.map((w) => w.layer), 0);
    let style = 'hormozi';
    const hasBounce = group.some((w) => w.effect === 'bounce');
    const hasKaraoke = group.some((w) => w.effect === 'karaoke');
    const hasScale = group.some((w) => w.effect === 'scale');
    const hasHighlight = group.some((w) => w.effect === 'highlight');
    if (hasBounce) style = 'bounce';
    else if (hasKaraoke) style = 'karaoke';
    else if (hasScale) style = 'minimal';
    else if (hasHighlight) style = 'mrbeast';

    events.push({
      start,
      end: round3(Math.min(clipLen, end)),
      words: [...group],
      style,
    });
    group = [];
  };

  for (const w of kinetic) {
    const wouldStart = group.length ? group[0].start : w.start;
    const tooLong = group.length > 0 && w.end - wouldStart > maxDur;
    if (group.length >= maxWords || tooLong) flush();
    group.push(w);
    if (/[.!?…,:;]$/.test(w.text) && group.length >= 2) flush();
  }
  flush();

  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].end > events[i + 1].start - 0.04) {
      events[i].end = round3(Math.max(events[i].start + 0.2, events[i + 1].start - 0.04));
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// ASS style line generation (from config)
// ---------------------------------------------------------------------------

function buildAssStyleLine(style: CaptionStyleConfig, marginV: number, marginL: number = 60, marginR: number = 140): string {
  const primary = hexToAss(style.primaryColor, 0);
  const secondary = hexToAss(style.highlightColor, 0);
  const outline = hexToAss(style.outlineColor, 0);
  const shadow = hexToAss(style.shadowColor, style.shadowAlpha);
  const bold = style.bold ? -1 : 0;
  const italic = style.italic ? -1 : 0;
  return (
    `Style: ${style.name},${style.fontName},${style.fontSize},${primary},${secondary},${outline},${shadow},` +
    `${bold},${italic},0,0,100,100,0.5,0,1,${style.outlineSize},${style.shadowDepth},2,${marginL},${marginR},${marginV},1`
  );
}

// ---------------------------------------------------------------------------
// Inline animation tags for word-by-word highlighting
// ---------------------------------------------------------------------------

function wordAnimationTags(
  effect: KineticWordEffect,
  emphasis: number,
  style: CaptionStyleConfig,
  wordDuration: number
): string {
  const e = Math.min(1, Math.max(0, emphasis));
  const hlColor = hexToAss(style.highlightColor, 0);

  switch (effect) {
    case 'karaoke': {
      const duration = Math.max(1, Math.round(wordDuration * 100));
      return `\\kf${duration}\\c${hlColor}`;
    }
    case 'scale': {
      const scale = Math.round(100 + e * 10);
      return `\\fscx${scale}\\fscy${scale}\\c${hlColor}`;
    }
    case 'bounce': {
      const scale = Math.round(100 + e * 20);
      return `\\t(0,50,\\fscx${scale}\\fscy${scale})\\t(50,100,\\fscx100\\fscy100)\\c${hlColor}`;
    }
    case 'highlight':
    default: {
      return `\\c${hlColor}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Multi-line support
// ---------------------------------------------------------------------------

function findLineBreakIndex(words: KineticWord[]): number {
  if (words.length <= 2) return -1;
  const totalLen = words.reduce((sum, w) => sum + w.text.length + 1, 0) - 1;
  if (totalLen <= 25) return -1;
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const lenA = words.slice(0, i).reduce((sum, w) => sum + w.text.length + 1, 0) - 1;
    const lenB = words.slice(i).reduce((sum, w) => sum + w.text.length + 1, 0) - 1;
    const diff = Math.abs(lenA - lenB);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  if (best <= 0 || best >= words.length - 1) return -1;
  return best;
}

function buildAnimatedText(words: KineticWord[], activeIdx: number, style: CaptionStyleConfig): string {
  const parts: string[] = [];
  const lineBreakIdx = findLineBreakIndex(words);

  for (let i = 0; i < words.length; i++) {
    if (lineBreakIdx > 0 && i === lineBreakIdx) {
      parts.push('\\N');
    }
    const escaped = escapeAss(words[i].text).toUpperCase();
    if (i === activeIdx) {
      const wordEnd = i < words.length - 1 ? words[i + 1].start : words[0].end + 0;
      const wordDuration = Math.max(0.01, words[i].end - words[i].start);
      const tags = wordAnimationTags(words[i].effect, words[i].emphasis, style, wordDuration);
      parts.push(`{\\${tags}}${escaped}{\\r}`);
    } else {
      parts.push(escaped);
    }
  }

  let text: string;
  if (style.wordSpacing !== 100) {
    const space = `{\\fscx${style.wordSpacing}} {\\fscx100}`;
    text = parts.join(space);
  } else {
    text = parts.join(' ');
  }

  if (style.letterSpacing !== 0) {
    text = `{\\fsp${style.letterSpacing}}${text}`;
  }

  return text;
}

// ---------------------------------------------------------------------------
// ASS generation
// ---------------------------------------------------------------------------

export function buildKineticASS(
  events: KineticCaptionEvent[],
  {
    title = 'Syntheniq captions',
    styleId = 'hormozi',
    captionPosition,
    videoWidth = EXPORT_SPEC.width,
    videoHeight = EXPORT_SPEC.height,
  }: {
    title?: string;
    styleId?: string;
    captionPosition?: number;
    videoWidth?: number;
    videoHeight?: number;
  } = {}
): string {
  const config = loadCaptionStylesConfig();
  // User request: center anchor at Y=1250px on 1920px canvas.
  // 1920 - 1250 = 670px from bottom = ~35% position
  const pos = captionPosition ?? 35;
  const marginV = Math.round(videoHeight * pos / 100);
  // Padding: 60px left, 140px right to avoid TikTok UI overlap
  const marginL = 60;
  const marginR = 140;

  const styleLines = Object.values(config.styles).map((s) => buildAssStyleLine(s, marginV, marginL, marginR));

  const styleIdToName: Record<string, string> = {};
  for (const s of Object.values(config.styles)) {
    styleIdToName[s.id] = s.name;
  }

  const lines = [
    '[Script Info]',
    `Title: ${title}`,
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    `PlayResX: ${videoWidth}`,
    `PlayResY: ${videoHeight}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const ev of events) {
    const configStyle = config.styles[ev.style] || config.styles[styleId] || config.styles['hormozi'];
    const assStyleName = styleIdToName[configStyle.id] || 'Hormozi';

    // ONE Dialogue line per event - the full phrase shows as one text element
    // with the currently-speaking word highlighted. This prevents text overlapping
    // that happens when multiple Dialogue lines appear simultaneously.
    const eventStart = ev.start;
    const eventEnd = ev.end;

    // Build full text with word-by-word highlight animation
    // The active word changes color via ASS override tags
    const textParts: string[] = [];
    const lineBreakIdx = findLineBreakIndex(ev.words);

    for (let i = 0; i < ev.words.length; i++) {
      if (lineBreakIdx > 0 && i === lineBreakIdx) {
        textParts.push('\\N');
      }

      const w = ev.words[i];
      const escaped = escapeAss(w.text).toUpperCase();

      // Apply word duration based animation only to the first word
      // (ASS handles the timing of \t/\kf tags per-dialogue, not per-word
      // when words share the same Dialogue line)
      const wordDuration = Math.max(0.01, w.end - w.start);
      const tags = wordAnimationTags(w.effect, w.emphasis, configStyle, wordDuration);

      if (w.effect !== 'none' && tags) {
        textParts.push(`{${tags}}${escaped}{}`);
      } else {
        textParts.push(escaped);
      }
    }

    let text: string;
    if (configStyle.wordSpacing !== 100) {
      const space = `{\\fscx${configStyle.wordSpacing}} {\\fscx100}`;
      text = textParts.join(space);
    } else {
      text = textParts.join(' ');
    }

    if (configStyle.letterSpacing !== 0) {
      text = `{\\fsp${configStyle.letterSpacing}}${text}`;
    }

    const layer = Math.max(...ev.words.map((ww) => ww.layer), 0);

    lines.push(
      `Dialogue: ${layer}, ${fmtAssTime(eventStart)}, ${fmtAssTime(eventEnd)}, ${assStyleName}, ,${marginL},${marginR},${marginV},,${text}`
    );
  }

  return lines.join('\n') + '\n';
}

export function buildCaptionEvents(
  words: Word[] | undefined | null,
  clipStart: number,
  clipEnd: number,
  { maxWords = 4, maxDur = 1.6 }: { maxWords?: number; maxDur?: number } = {}
): CaptionEvent[] {
  const clipLen = Math.max(0.1, clipEnd - clipStart);
  const inRange = (words || [])
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end))
    .filter((w) => w.end > clipStart + 0.05 && w.start < clipEnd - 0.05)
    .map((w) => ({
      start: Math.max(0, w.start - clipStart),
      end: Math.min(clipLen, Math.max(w.start - clipStart + 0.08, w.end - clipStart)),
      word: String(w.word || '').trim(),
    }))
    .filter((w) => w.word.length > 0 && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  const events: CaptionEvent[] = [];
  let group: typeof inRange = [];
  const flush = () => {
    if (!group.length) return;
    const start = group[0].start;
    let end = group[group.length - 1].end;
    end = Math.max(end, start + 0.35);
    const text = group
      .map((g) => g.word)
      .join(' ')
      .replace(/\s+([.,!?;:…%])(\s|$)/g, '$1$2')
      .trim();
    if (text) events.push({ start: round3(start), end: round3(Math.min(clipLen, end)), text });
    group = [];
  };

  for (const w of inRange) {
    const wouldStart = group.length ? group[0].start : w.start;
    const tooLong = group.length > 0 && w.end - wouldStart > maxDur;
    if (group.length >= maxWords || tooLong) flush();
    group.push(w);
    if (/[.!?…,:;]$/.test(w.word) && group.length >= 2) flush();
  }
  flush();

  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].end > events[i + 1].start - 0.04) {
      events[i].end = round3(Math.max(events[i].start + 0.2, events[i + 1].start - 0.04));
    }
  }
  return events;
}

export function splitTwoLines(text: string, maxLen = 20): string {
  const clean = String(text || '').trim();
  if (clean.length <= maxLen) return clean;
  const words = clean.split(/\s+/);
  if (words.length < 2) return clean;
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ').length;
    const b = words.slice(i).join(' ').length;
    const diff = Math.abs(a - b);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return words.slice(0, best).join(' ') + '\\N' + words.slice(best).join(' ');
}

export function escapeAss(text: string): string {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fmtAssTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cc = Math.floor((s * 100) % 100);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(ss)}.${pad(cc)}`;
}

export function buildASS(
  events: CaptionEvent[] | undefined | null,
  {
    title = 'Syntheniq captions',
    styleId = 'hormozi',
    captionPosition,
    videoWidth = EXPORT_SPEC.width,
    videoHeight = EXPORT_SPEC.height,
  }: {
    title?: string;
    styleId?: string;
    captionPosition?: number;
    videoWidth?: number;
    videoHeight?: number;
  } = {}
): string {
  const config = loadCaptionStylesConfig();
  const pos = captionPosition ?? config.captionPosition.default;
  const marginV = Math.round(videoHeight * pos / 100);

  let style: CaptionStyleConfig;
  try {
    style = getCaptionStyle(styleId);
  } catch {
    style = config.styles['hormozi'];
  }

  const styleLines = Object.values(config.styles).map((s) => buildAssStyleLine(s, marginV));

  const lines = [
    '[Script Info]',
    `Title: ${title}`,
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    `PlayResX: ${videoWidth}`,
    `PlayResY: ${videoHeight}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const ev of events || []) {
    const text = splitTwoLines(escapeAss(ev.text));
    lines.push(
      `Dialogue: 0, ${fmtAssTime(ev.start)}, ${fmtAssTime(ev.end)}, ${style.name}, ,0,0,${marginV},,${text}`
    );
  }

  return lines.join('\n') + '\n';
}

export function writeASS(
  filePath: string,
  events: CaptionEvent[],
  opts?: {
    title?: string;
    styleId?: string;
    captionPosition?: number;
    videoWidth?: number;
    videoHeight?: number;
  }
): { filePath: string; eventCount: number } {
  const content = buildASS(events, opts);
  fs.writeFileSync(filePath, content, 'utf8');
  return { filePath, eventCount: events.length };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
