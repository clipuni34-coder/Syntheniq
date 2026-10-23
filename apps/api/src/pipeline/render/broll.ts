// Syntheniq — Content-aware B-roll keyword mapping.
// Maps transcript keywords to search queries for free stock video APIs
// (Pixabay, Pexels) and provides smart B-roll selection.
import type { BRollCue, Word } from '../../types.js';
import fs from 'node:fs';
import path from 'node:path';

/** Path to bundled library of pre-downloaded clips */
const BROLL_LIBRARY_DIR = path.resolve(import.meta.dirname, '../../assets/broll/library');

/** Find a clip from the bundled library for a given keyword. 
 * Searches the local library directory for clips matching the keyword.
 */
function findLibraryClip(keyword: string): string | null {
  if (!fs.existsSync(BROLL_LIBRARY_DIR)) return null;

  // First, try direct keyword match against category folders
  const categories = fs.readdirSync(BROLL_LIBRARY_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const category of categories) {
    // Skip directories that don't match any keyword category
    if (!(category in BROLL_KEYWORD_MAP)) continue;
    
    // Check if keyword matches this category
    const categoryKeywords = BROLL_KEYWORD_MAP[category] || [category];
    if (categoryKeywords.includes(keyword) || keyword.includes(category)) {
      const categoryDir = path.join(BROLL_LIBRARY_DIR, category);
      const videos = fs.readdirSync(categoryDir).filter(f => 
        f.endsWith('.mp4') || f.endsWith('.mov') || f.endsWith('.avi')
      );
      
      if (videos.length > 0) {
        const randomFile = videos[Math.floor(Math.random() * videos.length)];
        const filePath = path.join(categoryDir, randomFile);
        if (fs.existsSync(filePath)) {
          return filePath;
        }
      }
    }
  }

  // Try matching via BROLL_KEYWORD_MAP categories
  const searchTerm = matchKeywordToBroll(keyword);
  if (searchTerm) {
    const categoryDir = path.join(BROLL_LIBRARY_DIR, searchTerm);
    if (fs.existsSync(categoryDir)) {
      const videos = fs.readdirSync(categoryDir).filter(f => 
        f.endsWith('.mp4') || f.endsWith('.mov') || f.endsWith('.avi')
      );
      
      if (videos.length > 0) {
        const randomFile = videos[Math.floor(Math.random() * videos.length)];
        const filePath = path.join(categoryDir, randomFile);
        if (fs.existsSync(filePath)) {
          return filePath;
        }
      }
    }
  }

  // Fallback: scan all categories for any video that might match
  for (const category of categories) {
    const categoryDir = path.join(BROLL_LIBRARY_DIR, category);
    const videos = fs.readdirSync(categoryDir).filter(f => 
      f.endsWith('.mp4') || f.endsWith('.mov') || f.endsWith('.avi')
    );
    
    if (videos.length > 0) {
      const matchingVideo = videos.find(v => 
        v.toLowerCase().includes(keyword) || 
        keyword.includes(v.toLowerCase().replace(/\.[^/.]+$/, ""))
      );
      
      if (matchingVideo) {
        return path.join(categoryDir, matchingVideo);
      }
    }
  }

  return null;
}

/** Keywords mapped to B-roll search queries.
 * These run against the Pixabay/Pexels video search APIs.
 * Each keyword triggers a relevant visual overlay.
 */
export const BROLL_KEYWORD_MAP: Record<string, string[]> = {
  // Business & Money
  money: ['money', 'cash', 'dollars', 'wealth', 'rich', 'bank', 'finance', 'investment'],
  business: ['business', 'office', 'work', 'corporate', 'meeting', 'deal', 'startup'],
  stock: ['stocks', 'trading', 'market', 'investment'],

  // Technology
  tech: ['technology', 'computer', 'coding', 'developer', 'app', 'software', 'digital'],
  phone: ['phone', 'smartphone', 'mobile'],
  internet: ['internet', 'web', 'online', 'website'],

  // People & Social
  people: ['people', 'crowd', 'team', 'community', 'friends', 'social'],
  talk: ['talking', 'speaking', 'conversation', 'interview'],
  meeting: ['meeting', 'conference', 'presentation'],

  // Lifestyle
  food: ['food', 'restaurant', 'cooking', 'eating', 'cuisine', 'coffee'],
  travel: ['travel', 'vacation', 'beach', 'mountain', 'city', 'adventure'],
  workout: ['fitness', 'gym', 'exercise', 'workout', 'training'],
  nature: ['nature', 'forest', 'tree', 'flower', 'outdoor'],

  // Success & Achievement
  success: ['success', 'achievement', 'win', 'goal', 'victory', 'celebration'],
  failure: ['failure', 'fail', 'mistake', 'problem', 'struggle'],
  learn: ['learning', 'study', 'education', 'reading', 'knowledge'],

  // Money & Finance (expanded)
  'crypto': ['crypto', 'bitcoin', 'blockchain'],
  'sell': ['sell', 'sales', 'marketing'],
  'buy': ['buy', 'purchase', 'shopping'],

  // Time & Planning
  time: ['time', 'clock', 'schedule', 'plan', 'calendar'],
  future: ['future', 'tomorrow', 'planning'],

  // Money actions
  earn: ['earn', 'income', 'salary', 'paycheck'],
  save: ['save', 'saving', 'budget'],

  // Work types
  code: ['coding', 'programming', 'developer', 'computer'],
  write: ['writing', 'typewriter', 'notebook'],
  create: ['creating', 'design', 'art'],

  // Numbers/Quantities
  million: ['money', 'wealth', 'numbers'],
  billion: ['money', 'wealth', 'numbers'],
  thousand: ['money', 'cash', 'numbers'],
  hundred: ['money', 'cash', 'numbers'],
};

/** Extract significant keywords from transcript words.
 * Filters out filler words, common stopwords, and returns the most
 * important content words with their timing.
 */
export function extractKeywords(words: Word[], clipStart: number, clipEnd: number): Array<{
  word: string;
  start: number;
  end: number;
}> {
  const stop_words = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those',
    'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'shall',
    'um', 'uh', 'like', 'you know', 'i mean', 'basically', 'actually',
  ]);

  const result: Array<{ word: string; start: number; end: number }> = [];
  const seen = new Set<string>();

  for (const w of words) {
    const text = String(w.word || '').trim().toLowerCase();
    const start = w.start;
    const end = w.end;

    // Skip fillers and stopwords
    if (!text || stop_words.has(text) || text.length < 3) continue;

    // Skip duplicates within a 5-second window
    const key = `${text}-${Math.floor(start / 5)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({ word: text, start, end });
  }

  return result;
}

/** Match a keyword to a B-roll search query. */
export function matchKeywordToBroll(keyword: string): string | null {
  const kw = keyword.toLowerCase();
  for (const [key, variants] of Object.entries(BROLL_KEYWORD_MAP)) {
    if (variants.includes(kw) || kw.includes(key)) {
      return key;
    }
  }
  return null;
}

/** Generate content-aware B-roll cues based on transcript keywords.
 * This creates B-roll overlay cues that match what's being said,
 * positioning them during relevant moments in the clip.
 */
export async function generateKeywordBRollCues(
  words: Word[],
  clipStart: number,
  clipEnd: number,
  apiKey?: string
): Promise<BRollCue[]> {
  const keywords = extractKeywords(words, clipStart, clipEnd);
  const cues: BRollCue[] = [];

  for (const kw of keywords) {
    const searchTerm = matchKeywordToBroll(kw.word);
    if (!searchTerm) continue;

    // 1. Try bundled library first (free, no API calls)
    const libraryClip = findLibraryClip(kw.word);
    if (libraryClip) {
      cues.push({
        id: `lib-${kw.word}-${Math.round(kw.start)}`,
        source: libraryClip,
        clipStart: kw.start,
        clipEnd: kw.end,
        outStart: Math.max(0, kw.start - clipStart),
        outDuration: Math.min(2.5, (kw.end - kw.start) * 2),
        layer: 10,
        kenBurns: { zoomStart: 1.15, zoomEnd: 1.3 },
        fade: { in: 0.3, out: 0.3 },
      });
      continue;
    }

    // 2. Try Pixabay API if key is available
    if (apiKey) {
      try {
        const videoUrl = await searchPixabayVideo(apiKey, searchTerm);
        if (videoUrl) {
          cues.push({
            id: `kw-${kw.word}-${Math.round(kw.start)}`,
            source: videoUrl,
            clipStart: kw.start,
            clipEnd: kw.end,
            outStart: kw.start - clipStart,
            outDuration: Math.min(2.5, (kw.end - kw.start) * 2),
            layer: 10,
            kenBurns: { zoomStart: 1.15, zoomEnd: 1.3 },
            fade: { in: 0.3, out: 0.3 },
          });
          continue;
        }
      } catch {
        // Fall through to synthetic fallback
      }
    }

    // Fallback: generate synthetic B-roll with keyword-relevant color
    const colors: Record<string, string> = {
      money: '0x4CAF50', green: '0x4CAF50',
      business: '0x2196F3', tech: '0x2196F3',
      nature: '0x4CAF50', food: '0xFF9800',
      success: '0x4CAF50', failure: '0xF44336',
      time: '0x9C27B0', future: '0x9C27B0',
      people: '0xFF9800', stock: '0x4CAF50',
    };

    cues.push({
      id: `synth-${kw.word}-${Math.round(kw.start)}`,
      source: `synthetic:${searchTerm}:${colors[searchTerm] || '0x2196F3'}`,
      clipStart: kw.start,
      clipEnd: kw.end,
      outStart: Math.max(0, kw.start - clipStart),
      outDuration: Math.min(2.5, (kw.end - kw.start) * 2),
      layer: 10,
      kenBurns: { zoomStart: 1.15, zoomEnd: 1.3 },
      fade: { in: 0.3, out: 0.3 },
    });
  }

  // Limit to 3 cues max per clip for visual clarity
  return cues.slice(0, 3);
}

/** Search Pixabay API for a relevant video clip.
 * Returns a direct video URL if found.
 */
export async function searchPixabayVideo(apiKey: string, query: string): Promise<string | null> {
  const url = `https://pixabay.com/api/videos/?key=${apiKey}&q=${encodeURIComponent(query)}&orientation=vertical&per_page=3&order=top`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = await res.json();
  const hits = data.hits || [];
  if (hits.length === 0) return null;

  // Return the URL of the first video
  const video = hits[0].videos?.large || hits[0].videos?.medium || hits[0].videos?.small;
  return video?.url || null;
}

/** Check if a B-roll source is synthetic (generated fallback). */
export function isSyntheticBroll(source: string): boolean {
  return source.startsWith('synthetic:');
}
