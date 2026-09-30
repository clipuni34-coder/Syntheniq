import { parseJson } from './openai.js';
import { AiError, type LLMRequest, type LLMResult } from './types.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Google Gemini API — v1beta generateContent REST (current official API as of 2026-09).
 * Key via `x-goog-api-key`. Structured output via
 * generationConfig.responseMimeType = "application/json". Verified against
 * ai.google.dev docs 2026-09-15 (models: gemini-3.8-flash, gemini-3.5-flash-lite, …).
 */
export async function callGemini(req: LLMRequest, apiKey: string, model: string): Promise<LLMResult> {
  const t0 = Date.now();

  const parts: Array<Record<string, unknown>> = [];
  for (const img of req.images ?? []) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }
  parts.push({ text: req.input });

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: req.temperature ?? 0.3,
      maxOutputTokens: req.maxTokens ?? 8192,
    },
  };
  if (req.json) (body.generationConfig as any).responseMimeType = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new AiError(`gemini network error: ${(e as Error).message}`, true);
  }

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
    throw new AiError(`gemini ${model}: ${msg}`, retryable, res.status);
  }

  const cand = data?.candidates?.[0];
  if (!cand) {
    const reason = data?.promptFeedback?.blockReason || 'no candidate returned';
    throw new AiError(`gemini ${model}: ${reason}`, false, res.status);
  }
  if (cand.finishReason && cand.finishReason !== 'STOP') {
    // MAX_TOKENS etc. — partial output; retry once with the same provider is pointless,
    // surface as non-retryable unless it was an overload.
    const retryable = cand.finishReason === 'SAFETY' ? false : true;
    throw new AiError(`gemini ${model}: finishReason ${cand.finishReason}`, retryable);
  }

  const text: string = (cand.content?.parts ?? [])
    .map((p: any) => p.text ?? '')
    .join('');
  return {
    text,
    json: req.json ? parseJson(text) : null,
    provider: 'gemini',
    model,
    latencyMs: Date.now() - t0,
  };
}
