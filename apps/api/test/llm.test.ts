// Syntheniq — LLM editorial layer: schema validation, merge semantics,
// provider protocol (chunking, retry, timeout) against a fake transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAiEditorialProvider,
  applyLlmEvaluations,
  buildEditorialPrompt,
  buildTranscriptContext,
  validateEvaluation,
  type LlmCandidate,
  type LlmEvaluation,
} from '../src/pipeline/editorial/llm.js';
import type { Clip, Scores } from '../src/types.js';

function scores(v = 0.5): Scores {
  return { hook: v, curiosity: v, payoff: v, standalone: v, emotion: v, visual: v };
}

function clip(id: string): Clip {
  return {
    id,
    rank: 1,
    start: 0,
    end: 30,
    duration: 30,
    title: 'Heuristic Title',
    excerpt: 'some words',
    scores: scores(0.4),
    heuristicScores: scores(0.4),
    decidedBy: 'heuristic',
    total: 0.4,
    reasons: ['a', 'b', 'c', 'd', 'e', 'f'],
    exported: null,
  };
}

function candidate(id: string): LlmCandidate {
  return {
    id,
    start: 0,
    end: 30,
    text: 'the moment everything changed',
    signals: { sceneCuts: 3, speechRatio: 0.9, energyVariance: 0.02 },
  };
}

function responsePayload(ids: string[]): unknown {
  return {
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              evaluations: ids.map((id) => ({
                id,
                scores: { hook: 0.9, curiosity: 0.8, payoff: 0.85, standalone: 0.7, emotion: 0.75, visual: 0.6 },
                reasons: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
                title: 'LLM Title',
              })),
            }),
          },
        ],
      },
    ],
  };
}

test('validateEvaluation accepts a conforming evaluation and clamps scores', () => {
  const ev = validateEvaluation({
    id: 'clip-1',
    scores: { hook: 1.5, curiosity: -0.2, payoff: 0.5, standalone: 0.5, emotion: 0.5, visual: 0.5 },
    reasons: ['a', 'b', 'c', 'd', 'e', 'f'],
    title: '  Title Case  ',
  });
  assert.ok(ev);
  assert.equal(ev!.scores.hook, 1);
  assert.equal(ev!.scores.curiosity, 0);
  assert.equal(ev!.title, 'Title Case');
});

test('validateEvaluation rejects malformed candidates individually', () => {
  assert.equal(validateEvaluation(null), null);
  assert.equal(validateEvaluation({}), null);
  assert.equal(
    validateEvaluation({
      id: 'x',
      scores: { hook: 'high', curiosity: 0.5, payoff: 0.5, standalone: 0.5, emotion: 0.5, visual: 0.5 },
      reasons: ['a', 'b', 'c', 'd', 'e', 'f'],
      title: 't',
    }),
    null
  );
  assert.equal(
    validateEvaluation({
      id: 'x',
      scores: scores(),
      reasons: ['only', 'two'],
      title: 't',
    }),
    null
  );
  assert.equal(
    validateEvaluation({
      id: 'x',
      scores: scores(),
      reasons: ['a', 'b', 'c', 'd', 'e', ''],
      title: 't',
    }),
    null
  );
  const noTitle = validateEvaluation({ id: 'x', scores: scores(0.5), reasons: ['a', 'b', 'c', 'd', 'e', 'f'] });
  assert.ok(noTitle);
  assert.equal(noTitle!.title, '');
});

test('applyLlmEvaluations merges scores and keeps heuristic as fallback', () => {
  const clips = [clip('clip-1'), clip('clip-2')];
  const evals: LlmEvaluation[] = [
    {
      id: 'clip-1',
      scores: { hook: 0.9, curiosity: 0.9, payoff: 0.9, standalone: 0.9, emotion: 0.9, visual: 0.9 },
      reasons: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
      title: 'LLM Title',
    },
  ];
  const { applied, skipped } = applyLlmEvaluations(clips, evals);
  assert.equal(applied, 1);
  assert.equal(skipped, 1);
  assert.equal(clips[0].decidedBy, 'llm');
  assert.equal(clips[0].title, 'LLM Title');
  assert.equal(clips[0].scores.hook, 0.9);
  assert.equal(clips[0].heuristicScores.hook, 0.4);
  assert.equal(clips[0].total, 0.9);
  assert.equal(clips[1].decidedBy, 'heuristic');
  assert.equal(clips[1].scores.hook, 0.4);
});

test('buildEditorialPrompt grounds candidates in transcript + signals', () => {
  const { system, user } = buildEditorialPrompt({
    transcriptContext: 'full talk text here',
    candidates: [candidate('clip-3')],
  });
  assert.ok(system.includes('0..1'));
  assert.ok(user.includes('clip-3'));
  assert.ok(user.includes('sceneCuts=3'));
  assert.ok(user.includes('full talk text here'));
});

test('buildTranscriptContext caps length with a truncation marker', () => {
  const segs = Array.from({ length: 500 }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 9,
    text: 'lorem ipsum dolor sit amet '.repeat(4),
  }));
  const ctx = buildTranscriptContext(segs, 1000);
  assert.ok(ctx.length <= 1100);
  assert.ok(ctx.includes('truncated'));
  assert.equal(buildTranscriptContext([], 1000), '');
});

test('provider posts structured requests and parses evaluations', async () => {
  const calls: { url: string; body: any }[] = [];
  const provider = new OpenAiEditorialProvider({
    apiKey: 'test-key',
    baseUrl: 'https://llm.example/v1',
    model: 'test-model',
    timeoutMs: 5000,
    fetchImpl: (async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(responsePayload(['clip-1', 'clip-2'])), { status: 200 });
    }) as never,
  });
  const evals = await provider.evaluate({ transcriptContext: 'ctx', candidates: [candidate('clip-1'), candidate('clip-2')] });
  assert.equal(evals.length, 2);
  assert.equal(evals[0].id, 'clip-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://llm.example/v1/responses');
  assert.equal(calls[0].body.model, 'test-model');
  assert.equal(calls[0].body.response_format.json_schema.strict, true);
  assert.deepEqual(
    calls[0].body.input.map((m: any) => m.role),
    ['system', 'user']
  );
});

test('provider chunks large candidate sets', async () => {
  let calls = 0;
  const provider = new OpenAiEditorialProvider({
    apiKey: 'k',
    baseUrl: 'https://llm.example/v1',
    chunkSize: 20,
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify(responsePayload([`clip-${calls}`])), { status: 200 });
    }) as never,
  });
  const cands = Array.from({ length: 25 }, (_, i) => candidate(`clip-${i}`));
  await provider.evaluate({ transcriptContext: 'ctx', candidates: cands });
  assert.equal(calls, 2);
});

test('provider retries once on 429 then succeeds', async () => {
  let calls = 0;
  const provider = new OpenAiEditorialProvider({
    apiKey: 'k',
    baseUrl: 'https://llm.example/v1',
    fetchImpl: (async () => {
      calls++;
      if (calls === 1) return new Response('slow down', { status: 429 });
      return new Response(JSON.stringify(responsePayload(['clip-1'])), { status: 200 });
    }) as never,
  });
  const evals = await provider.evaluate({ transcriptContext: 'ctx', candidates: [candidate('clip-1')] });
  assert.equal(evals.length, 1);
  assert.equal(calls, 2);
});

test('provider throws LlmError on invalid JSON and non-retryable statuses', async () => {
  const badEnvelope = new OpenAiEditorialProvider({
    apiKey: 'k',
    baseUrl: 'https://llm.example/v1',
    fetchImpl: (async () => new Response('not json', { status: 200 })) as never,
  });
  await assert.rejects(
    () => badEnvelope.evaluate({ transcriptContext: 'c', candidates: [candidate('clip-1')] }),
    /editorial request failed/
  );

  const badInner = new OpenAiEditorialProvider({
    apiKey: 'k',
    baseUrl: 'https://llm.example/v1',
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] }),
        { status: 200 }
      )) as never,
  });
  await assert.rejects(
    () => badInner.evaluate({ transcriptContext: 'c', candidates: [candidate('clip-1')] }),
    /invalid JSON/
  );

  let calls = 0;
  const clientErr = new OpenAiEditorialProvider({
    apiKey: 'k',
    baseUrl: 'https://llm.example/v1',
    fetchImpl: (async () => {
      calls++;
      return new Response('bad request', { status: 400 });
    }) as never,
  });
  await assert.rejects(
    () => clientErr.evaluate({ transcriptContext: 'c', candidates: [candidate('clip-1')] }),
    /400/
  );
  assert.equal(calls, 1);
});

test('provider throws LlmError on timeout', async () => {
  const hanging = new OpenAiEditorialProvider({
    apiKey: 'k',
    baseUrl: 'https://llm.example/v1',
    timeoutMs: 50,
    fetchImpl: ((url: string, init?: Record<string, unknown>) =>
      new Promise((_resolve, reject) => {
        // A transport that never answers: the abort signal (or our own
        // backstop) must settle it — the provider must never hang.
        const backstop = setTimeout(() => reject(new Error('transport timed out')), 300);
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(backstop);
            reject(new Error('aborted'));
          });
        }
      })) as never,
  });
  await assert.rejects(
    () => hanging.evaluate({ transcriptContext: 'c', candidates: [candidate('clip-1')] }),
    /LlmError|aborted|failed/
  );
});
