import { parseJson } from './openai.js';
import { AiError, type LLMRequest, type LLMResult } from './types.js';

const BASE = 'https://api.x.ai/v1';

/**
 * xAI Grok — OpenAI-compatible API at api.x.ai/v1 (current official API as of 2026-09).
 * Uses chat completions with response_format json_object for structured output
 * (verified against docs.x.ai structured-outputs page 2026-09-15; grok-4.6 is the
 * current flagship model).
 */
export async function callGrok(req: LLMRequest, apiKey: string, model: string): Promise<LLMResult> {
  const t0 = Date.now();

  const userContent: Array<Record<string, unknown>> = [];
  for (const img of req.images ?? []) {
    userContent.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
  }
  userContent.push({ type: 'text', text: req.input });

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: userContent },
    ],
    temperature: req.temperature ?? 0.3,
    max_tokens: req.maxTokens ?? 8000,
  };
  if (req.json) body.response_format = { type: 'json_object' };

  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new AiError(`grok network error: ${(e as Error).message}`, true);
  }

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
    throw new AiError(`grok ${model}: ${msg}`, retryable, res.status);
  }

  const text: string = data?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new AiError(`grok ${model}: empty completion`, true);
  return {
    text,
    json: req.json ? parseJson(text) : null,
    provider: 'grok',
    model,
    latencyMs: Date.now() - t0,
  };
}
