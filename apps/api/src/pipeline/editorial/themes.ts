import type { Segment, StructureData } from '../../types.js';
import { PAYOFF_MARKERS } from './lexicons.js';

export type ContentTheme =
  | 'howto'
  | 'listicle'
  | 'reaction'
  | 'storytime'
  | 'explainer'
  | 'shock'
  | 'motivational'
  | 'general';

export interface ThemeSignal {
  theme: ContentTheme;
  confidence: number;
  keywords: string[];
  strengths: string[];
  editingStrategy: string;
}

interface ThemePattern {
  themes: ContentTheme;
  keywords: string[];
  markers: string[];
  minConfidence: number;
}

const THEME_PATTERNS: ThemePattern[] = [
  {
    themes: 'howto',
    keywords: ['how to', 'step', 'tutorial', 'guide', 'learn', 'teach', 'instruction', 'walk through', 'walkthrough', 'tips', 'trick', 'diy', 'do it yourself'],
    markers: ['step one', 'step 1', 'first', 'then', 'finally', 'first step', 'next step', 'last step', 'in this video'],
    minConfidence: 0.3,
  },
  {
    themes: 'listicle',
    keywords: ['top', 'number', 'best', 'worst', 'rank', 'ranking', 'countdown', 'list', '#1', '#2', 'three things', 'five ways', 'ten reasons', 'ways to', 'things to'],
    markers: ['first', 'second', 'third', 'finally', 'lastly', 'in no order', 'ranked'],
    minConfidence: 0.25,
  },
  {
    themes: 'reaction',
    keywords: ['reaction', 'react', 'watching', 'i saw', 'i saw this', 'what happened when', 'my reaction', 'i tried', 'review', 'opinion', 'thoughts', 'first impression'],
    markers: ['wow', 'omg', 'no way', 'i cant believe', 'insane', 'crazy', 'actually', 'wait'],
    minConfidence: 0.3,
  },
  {
    themes: 'storytime',
    keywords: ['story', 'happened', 'once', 'i was', 'when i', 'last time', 'this one time', 'let me tell', 'back then', 'i used to', 'my experience', 'my journey', 'the day'],
    markers: ['so', 'after that', 'suddenly', 'then', 'when', 'because', 'until', 'but', 'meanwhile'],
    minConfidence: 0.3,
  },
  {
    themes: 'explainer',
    keywords: ['why', 'what is', 'how does', 'explained', 'break down', 'analysis', 'science', 'research', 'study', 'data', 'statistics', 'facts', 'fact', 'according to', 'actually', 'basically', 'essentially'],
    markers: ['because', 'therefore', 'however', 'for example', 'for instance', 'in other words', 'to summarize'],
    minConfidence: 0.25,
  },
  {
    themes: 'shock',
    keywords: ['shocking', 'unbelievable', 'insane', 'crazy', 'mind blowing', 'you wont believe', 'wait till', 'secret', 'hidden', 'scandal', 'exposed', 'lies', 'truth', 'banned', 'illegal', 'controversial', 'outrageous'],
    markers: ['suddenly', 'without warning', 'nobody expected', 'no one saw', 'plot twist', 'turns out', 'what happened next'],
    minConfidence: 0.35,
  },
  {
    themes: 'motivational',
    keywords: ['motivation', 'inspire', 'inspired', 'success', 'mindset', 'growth', 'habits', 'discipline', 'win', 'winning', 'champion', 'overcome', 'resilience', 'strength', 'mental', 'grind', 'hustle', 'dream', 'goal', 'achievement'],
    markers: ['you can', 'believe in', 'dont give up', 'keep going', 'never give up', 'stay strong', 'believe', 'push through', 'dont stop', 'its possible'],
    minConfidence: 0.3,
  },
];

const THEME_EDITING_STRATEGIES: Record<ContentTheme, string> = {
  howto: 'Emphasize payoff steps with text overlays, zoom into key actions, add SFX at transitions between steps',
  listicle: 'Use rapid cuts between items, numbered text overlays, impact SFX at each item reveal',
  reaction: 'Pace cuts to reaction intensity, add emphasis at surprise moments, subtle background music',
  storytime: 'Build narrative tension with dynamic cuts, emphasize emotional beats, use transition SFX between scenes',
  explainer: 'Add text overlays for key concepts, smooth transitions between topics, highlight data points',
  shock: 'High-energy cuts, impact effects at revelations, bright flashes, immediate hook with curiosity gap',
  motivational: 'Uplifting music, emphasis on key motivational phrases, smooth zoom-ins on emotional moments',
  general: 'Balanced editing with attention hooks at 2-3s marks, SFX on visual cues, varied transitions',
};

const THEME_STRENGTHS: Record<ContentTheme, string[]> = {
  howto: ['Clear step structure', 'Definite payoff', 'Educational value'],
  listicle: ['Ranked engagement', 'Easy consumption', 'Surprise/reveal pattern'],
  reaction: ['Authentic emotion', 'Relatability', 'Surprise factor'],
  storytime: ['Narrative tension', 'Character investment', 'Satisfying resolution'],
  explainer: ['Information density', 'Curiosity gaps', 'Knowledge reward'],
  shock: ['High retention', 'Shareability', 'Comment bait'],
  motivational: ['Uplifting energy', 'Relatable struggle', 'Clear takeaway'],
  general: ['Broad appeal', 'Universal structure'],
};

function tokenize(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,!?;:'"(){}\[\]#]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function simpleKeywordCount(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const matches = lower.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

export function detectContentTheme(segments: Segment[], structure: StructureData, duration: number): ThemeSignal {
  const text = (segments || [])
    .map((s) => s.text || '')
    .join(' ')
    .toLowerCase();

  const tokens = tokenize(text);
  const tokenCount = Math.max(1, tokens.length);
  const wordCount = Math.max(1, text.split(/\s+/).length);

  let bestTheme: ContentTheme = 'general';
  let bestScore = 0;
  let bestKeywords: string[] = [];
  let bestStrengths: string[] = [];

  for (const pattern of THEME_PATTERNS) {
    let score = 0;
    const matchedKeywords: string[] = [];

    for (const kw of pattern.keywords) {
      const kwTokens = tokenize(kw);
      if (kwTokens.length === 1) {
        const re = new RegExp(`\\b${kwTokens[0]}\\b`, 'g');
        const matches = text.match(re);
        if (matches) {
          score += matches.length;
          matchedKeywords.push(kw);
        }
      } else {
        if (text.includes(kw)) {
          score += 3;
          matchedKeywords.push(kw);
        }
      }
    }

    const markerMatches = simpleKeywordCount(text, pattern.markers);
    score += markerMatches * 2;

    const confidence = Math.min(1, score / Math.max(1, wordCount * 0.15));
    if (confidence > bestScore && confidence >= pattern.minConfidence) {
      bestScore = confidence;
      bestTheme = pattern.themes;
      bestKeywords = matchedKeywords;
      bestStrengths = THEME_STRENGTHS[pattern.themes];
    }
  }

  return {
    theme: bestTheme,
    confidence: bestScore,
    keywords: bestKeywords,
    strengths: bestStrengths,
    editingStrategy: THEME_EDITING_STRATEGIES[bestTheme],
  };
}

export interface DopamineMoment {
  time: number;
  type: 'hook' | 'reveal' | 'impact' | 'transition' | 'silence_break';
  intensity: number;
  rationale: string;
}

export function detectDopamineMoments(
  segments: Segment[],
  structure: StructureData,
  duration: number,
  hookStart: number = 0
): DopamineMoment[] {
  const moments: DopamineMoment[] = [];
  const { sceneCuts = [], energyCurve = [], speechActive = [], faceTrack = [] } = structure;

  const energyPoints = energyCurve.filter((p) => p.t >= 0 && p.t <= duration);
  if (energyPoints.length > 2) {
    const mean = energyPoints.reduce((a, p) => a + p.rms, 0) / energyPoints.length;
    const variance = energyPoints.reduce((a, p) => a + (p.rms - mean) ** 2, 0) / energyPoints.length;

    for (let i = 1; i < energyPoints.length - 1; i++) {
      const prev = energyPoints[i - 1];
      const curr = energyPoints[i];
      const next = energyPoints[i + 1];
      if (curr.rms > prev.rms * 1.5 && curr.rms > next.rms * 1.3) {
        moments.push({
          time: curr.t,
          type: 'impact',
          intensity: Math.min(1, (curr.rms - mean) / Math.max(0.001, variance)),
          rationale: 'Energy spike detected',
        });
      }
    }
  }

  for (const cut of sceneCuts) {
    if (cut < 0.5 || cut > duration - 0.5) continue;
    const sceneMoment = moments.find((m) => Math.abs(m.time - cut) < 0.5);
    if (!sceneMoment) {
      const intensity = 0.5;
      moments.push({
        time: cut,
        type: 'transition',
        intensity,
        rationale: 'Scene cut — natural transition point',
      });
    }
  }

  const speechSpans = (speechActive || []).filter((s) => s.end > 0 && s.start < duration);
  for (let i = 0; i < speechSpans.length; i++) {
    if (i > 0 && speechSpans[i].start - speechSpans[i - 1].end > 0.5) {
      const silenceEnd = speechSpans[i].start;
      moments.push({
        time: silenceEnd,
        type: 'silence_break',
        intensity: 0.6,
        rationale: 'Resume after silence — attention grab moment',
      });
    }
  }

  for (const seg of segments || []) {
    const text = (seg.text || '').toLowerCase();
    if (/\b(why|how|what|who|when|which)\b/.test(text) && seg.start < duration * 0.3) {
      moments.push({
        time: seg.start,
        type: 'hook',
        intensity: 0.7,
        rationale: 'Question-based hook at opening',
      });
    }
    if (PAYOFF_MARKERS.some((m) => text.includes(m))) {
      moments.push({
        time: seg.start,
        type: 'reveal',
        intensity: 0.8,
        rationale: 'Payoff/revelation language detected',
      });
    }
  }

  moments.sort((a, b) => a.time - b.time);

  const deduped: DopamineMoment[] = [];
  for (const m of moments) {
    const nearby = deduped.find((d) => Math.abs(d.time - m.time) < 1);
    if (!nearby) {
      deduped.push(m);
    }
  }

  return deduped.slice(0, 12);
}

export function themeEditingProfile(theme: ContentTheme): {
  targetSegmentCount: number;
  preferredTransitions: string[];
  sfxDensity: number;
  textDensity: number;
  emphasisPoints: number;
  energyTarget: number;
} {
  const profiles: Record<ContentTheme, ReturnType<typeof themeEditingProfile>> = {
    howto: {
      targetSegmentCount: 4,
      preferredTransitions: ['wipe', 'dissolve', 'flash'],
      sfxDensity: 0.5,
      textDensity: 0.8,
      emphasisPoints: 4,
      energyTarget: 0.6,
    },
    listicle: {
      targetSegmentCount: 6,
      preferredTransitions: ['flash', 'wipe', 'flash'],
      sfxDensity: 0.9,
      textDensity: 0.9,
      emphasisPoints: 6,
      energyTarget: 0.7,
    },
    reaction: {
      targetSegmentCount: 5,
      preferredTransitions: ['dissolve', 'flash', 'wipe'],
      sfxDensity: 0.4,
      textDensity: 0.3,
      emphasisPoints: 5,
      energyTarget: 0.5,
    },
    storytime: {
      targetSegmentCount: 5,
      preferredTransitions: ['dissolve', 'wipe', 'dissolve'],
      sfxDensity: 0.6,
      textDensity: 0.4,
      emphasisPoints: 4,
      energyTarget: 0.6,
    },
    explainer: {
      targetSegmentCount: 4,
      preferredTransitions: ['wipe', 'dissolve', 'wipe'],
      sfxDensity: 0.4,
      textDensity: 0.7,
      emphasisPoints: 3,
      energyTarget: 0.5,
    },
    shock: {
      targetSegmentCount: 6,
      preferredTransitions: ['flash', 'flash', 'flash'],
      sfxDensity: 1.0,
      textDensity: 0.6,
      emphasisPoints: 8,
      energyTarget: 0.8,
    },
    motivational: {
      targetSegmentCount: 4,
      preferredTransitions: ['dissolve', 'wipe', 'dissolve'],
      sfxDensity: 0.5,
      textDensity: 0.5,
      emphasisPoints: 4,
      energyTarget: 0.7,
    },
    general: {
      targetSegmentCount: 3,
      preferredTransitions: ['dissolve', 'flash', 'wipe'],
      sfxDensity: 0.6,
      textDensity: 0.5,
      emphasisPoints: 3,
      energyTarget: 0.5,
    },
  };
  return profiles[theme] || profiles.general;
}
