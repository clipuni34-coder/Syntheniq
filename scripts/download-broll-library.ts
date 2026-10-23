#!/usr/bin/env node
/**
 * B-roll Library Downloader
 * Downloads free stock videos for the bundled B-roll library.
 * 
 * Usage: 
 *   npx tsx scripts/download-broll-library.ts
 *   PIXABAY_API_KEY=your_key npx tsx scripts/download-broll-library.ts
 *   PIXEL_API_KEY=xxx PEXELS_API_KEY=xxx npx tsx scripts/download-broll-library.ts
 * 
 * This script downloads clips ONCE and stores them locally for unlimited reuse.
 * No API limits after initial download!
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// Library directory where clips are stored
const LIBRARY_DIR = path.resolve(process.cwd(), 'apps/api/assets/broll/library');

// Create a manifest entry for downloaded clips
interface LibraryEntry {
  filename: string;
  source: string;
  sourceAttribution: string;
  duration: number;
  resolution: string;
  keywords: string[];
  downloaded: string; // ISO date
}

interface LibraryCategory {
  files: string[];
  keywords: string[];
  description: string;
}

// Pixabay API client for bulk downloads
async function searchPixabayVideos(
  apiKey: string,
  query: string,
  count: number = 5
): Promise<Array<{ url: string; width: number; height: number; duration: number }>> {
  const url = `https://pixabay.com/api/videos/?key=${apiKey}&q=${encodeURIComponent(query)}&orientation=vertical&per_page=${count}&order=top`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay API error: ${res.status}`);
  
  const data = await res.json();
  const results = (data.hits || []).map((hit: any) => {
    // Prefer largest horizontal resolution (1920x1080 or 1280x720)
    const videos = hit.videos;
    const large = videos?.large || videos?.medium || videos?.small || videos?.tiny;
    return {
      url: large?.url || '',
      width: large?.width || 0,
      height: large?.height || 0,
      duration: hit.duration || 5,
    };
  }).filter((v: any) => v.url);
  
  return results;
}

// Download a video file
async function downloadVideo(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  
  const buffer = await res.arrayBuffer();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(buffer));
  console.log(`  Downloaded: ${path.basename(destPath)} (${buffer.byteLength / 1e6} MB)`);
}

// Main download function for a category
async function downloadCategory(
  category: string,
  keywords: string[],
  description: string,
  apiKey: string,
  clipCount: number = 3
): Promise<LibraryCategory> {
  const categoryDir = path.join(LIBRARY_DIR, category);
  fs.mkdirSync(categoryDir, { recursive: true });
  
  const existingFiles = fs.existsSync(path.join(categoryDir, '.gitkeep')) 
    ? fs.readdirSync(categoryDir).filter(f => !f.startsWith('.')) 
    : [];
  
  if (existingFiles.length > 0) {
    console.log(`[${category}] Already has ${existingFiles.length} clips, skipping`);
    return { files: existingFiles, keywords, description };
  }
  
  console.log(`\n[${category}] Downloading ${clipCount} clips for: ${keywords.join(', ')}`);
  const files: string[] = [];
  
  try {
    // Search for each primary keyword
    for (const kw of keywords.slice(0, Math.min(3, keywords.length))) {
      const results = await searchPixabayVideos(apiKey, kw, Math.ceil(clipCount / keywords.length));
      
      for (const result of results) {
        if (files.length >= clipCount) break;
        
        // Generate filename from keyword + index
        const fileIdx = files.length;
        const filename = `${kw}-${fileIdx + 1}.mp4`;
        const filepath = path.join(categoryDir, filename);
        
        try {
          await downloadVideo(result.url, filepath);
          files.push(filename);
        } catch (err) {
          console.error(`  Failed to download ${filename}: ${(err as Error).message}`);
        }
      }
      
      if (files.length >= clipCount) break;
    }
  } catch (err) {
    console.error(`[${category}] Error: ${(err as Error).message}`);
  }
  
  return { files, keywords, description };
}

// Main function
async function main() {
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) {
    console.error('PIXABAY_API_KEY environment variable required');
    process.exit(1);
  }
  
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  
  // Define which categories and keywords to download
  const categories = {
    business: {
      keywords: ['business', 'office', 'meeting', 'corporate'],
      description: 'Business, office, and corporate environments'
    },
    money: {
      keywords: ['money', 'cash', 'finance', 'investment'],
      description: 'Money, finance, and wealth visuals'
    },
    nature: {
      keywords: ['nature', 'forest', 'mountain', 'ocean'],
      description: 'Nature and outdoor scenes'
    },
    food: {
      keywords: ['food', 'restaurant', 'cooking', 'coffee'],
      description: 'Food, cooking, and restaurant scenes'
    },
    tech: {
      keywords: ['technology', 'computer', 'coding', 'digital'],
      description: 'Technology and computer scenes'
    },
    people: {
      keywords: ['people', 'crowd', 'team', 'social'],
      description: 'People and social scenes'
    },
    success: {
      keywords: ['success', 'achievement', 'celebration', 'victory'],
      description: 'Success and achievement visuals'
    },
    travel: {
      keywords: ['travel', 'beach', 'city', 'adventure'],
      description: 'Travel and adventure scenes'
    },
    workout: {
      keywords: ['fitness', 'gym', 'exercise', 'sports'],
      description: 'Fitness and exercise scenes'
    },
    crypto: {
      keywords: ['crypto', 'bitcoin', 'blockchain', 'trading'],
      description: 'Cryptocurrency and blockchain visuals'
    },
    time: {
      keywords: ['time', 'clock', 'calendar', 'planning'],
      description: 'Time, clocks, and scheduling'
    },
  };
  
  const manifest: Record<string, LibraryCategory> = {};
  
  for (const [category, config] of Object.entries(categories)) {
    const result = await downloadCategory(
      category,
      config.keywords,
      config.description,
      apiKey,
      3 // 3 clips per category = ~33 clips total
    );
    manifest[category] = result;
  }
  
  // Write manifest
  fs.writeFileSync(
    path.join(LIBRARY_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
  
  // Write gitkeep files to preserve empty directories
  const allDirs = fs.readdirSync(LIBRARY_DIR);
  for (const dir of allDirs) {
    const dirPath = path.join(LIBRARY_DIR, dir);
    if (fs.statSync(dirPath).isDirectory()) {
      const files = fs.readdirSync(dirPath);
      if (files.length === 0) {
        fs.writeFileSync(path.join(dirPath, '.gitkeep'), '');
      }
    }
  }
  
  console.log('\nLibrary download complete!');
  console.log(`Manifest saved to: ${path.join(LIBRARY_DIR, 'manifest.json')}`);
}

main().catch(console.error);
