// Syntheniq — clip ranking weights (the scoring contract).
// Hook 25% · Curiosity 20% · Payoff 20% · Standalone 15% · Emotion 10% · Visual 10%
import type { Scores } from '../../types.js';

export const WEIGHTS: Scores = {
  hook: 0.25,
  curiosity: 0.2,
  payoff: 0.2,
  standalone: 0.15,
  emotion: 0.1,
  visual: 0.1,
};

const SUM = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(SUM - 1) > 1e-9) {
  throw new Error(`Editorial weights must sum to 1, got ${SUM}`);
}

export function weightedTotal(scores: Scores): number {
  return (
    scores.hook * WEIGHTS.hook +
    scores.curiosity * WEIGHTS.curiosity +
    scores.payoff * WEIGHTS.payoff +
    scores.standalone * WEIGHTS.standalone +
    scores.emotion * WEIGHTS.emotion +
    scores.visual * WEIGHTS.visual
  );
}
