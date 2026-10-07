// Syntheniq — workspace path helpers. All derived media lives under DATA_DIR.
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR } from '../config.js';

export function projectDir(id: string): string {
  return path.join(DATA_DIR, 'projects', id);
}
export function sourceDir(id: string): string {
  return path.join(projectDir(id), 'source');
}
export function workDir(id: string): string {
  return path.join(projectDir(id), 'work');
}
export function clipsDir(id: string): string {
  return path.join(projectDir(id), 'clips');
}
export function clipDir(id: string, clipId: string): string {
  return path.join(clipsDir(id), clipId);
}
export function sourceFile(id: string, filename: string): string {
  return path.join(sourceDir(id), filename);
}
export function audioPath(id: string, suffix = 'full'): string {
  return path.join(workDir(id), `audio-${suffix}.wav`);
}
export function transcriptPath(id: string): string {
  return path.join(workDir(id), 'transcript.json');
}
export function structurePath(id: string): string {
  return path.join(workDir(id), 'structure.json');
}
export function analysisPath(id: string): string {
  return path.join(projectDir(id), 'analysis.json');
}
export function assPath(id: string, clipId: string): string {
  return path.join(clipDir(id, clipId), 'captions.ass');
}
export function exportPath(id: string, clipId: string): string {
  return path.join(clipDir(id, clipId), 'export.mp4');
}
export function posterPath(id: string, clipId: string): string {
  return path.join(clipDir(id, clipId), 'poster.jpg');
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
