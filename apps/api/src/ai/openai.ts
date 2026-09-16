import { AiError, type LLMRequest, type LLMResult } from './types.js';

const BASE = 'https://api.openai.com/v1';

/**
 * OpenAI — Responses API (current official API as of 2026-09).
 * POST /v1/responses with `instructions` + `input`, structured output via
 * `text.format = { type: "json" }`. Verified against official docs 2026-09-15.
 */
export async function callOpenai(req: LLMRequest, apiKey: string, model: string): Promise<LLMResult> {
  const t0 = Date.now();

  const content: Array<Record<string, unknown>> = [];
  for (const img of req.images ?? []) {
    content.push({
      type: 'input_image',
      image_url: `data:${img.mimeType};base64,${img.data}`,
    });
  }
  content.push({ type: 'input_text', text: req.input });

  const body: Record<string, unknown> = {
    model,
    instructions: req.system,
    input: [{ role: 'user', content }],
    temperature: req.temperature ?? 0.3,
    max_output_tokens: req.maxTokens ?? 8000,
  };
  if (req.json) body.text = { format: { type: 'json' } };

  let res: Response;
  try {
    res = await fetch(`${BASE}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new AiError(`openai network error: ${(e as Error).message}`, true);
  }

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
    throw new AiError(`openai ${model}: ${msg}`, retryable, res.status);
  }

  const text: string = typeof data.output_text === 'string' ? data.output_text : extractText(data);
  return {
    text,
    json: req.json ? parseJson(text) : null,
    provider: 'openai',
    model,
    latencyMs: Date.now() - t0,
  };
}

function extractText(data: any): string {
  const parts: string[] = [];
  for (const item of data?.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) if (c.type === 'output_text') parts.push(c.text);
    }
  }
  return parts.join('\n');
}

export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Strip code fences / trailing prose: find first { ... last }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error('provider returned non-JSON text');
  }
}
