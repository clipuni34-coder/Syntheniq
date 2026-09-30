import { AiError, type LLMRequest, type LLMResult } from './types.js';

const BASE = 'https://api.openai.com/v1';

/**
 * OpenAI — Responses API (current official API as of 2026-09).
 * POST /v1/responses with `instructions` + `input`.
 *
 * Live-verified contract (locked by test/openai-client.mjs, 2026-09-17):
 *  - structured output: `text.format = { type: "json_object" }` — the value
 *    "json" is REJECTED with 400; only json_object / text / json_schema work.
 *  - json_object requires the input to contain the lowercase word "json",
 *    otherwise the API 400s → we guard the input.
 *  - `temperature` is REJECTED (400) by some models (gpt-5.6-*) → per-model
 *    auto-learning: on a 400 mentioning temperature we remember the model
 *    and retry once without the field (never fail the job over it).
 */
const modelsRejectingTemperature = new Set<string>();

export function _resetTemperatureLearning(): void {
  modelsRejectingTemperature.clear();
}

function buildBody(req: LLMRequest, model: string, withTemperature: boolean): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  for (const img of req.images ?? []) {
    content.push({
      type: 'input_image',
      image_url: `data:${img.mimeType};base64,${img.data}`,
    });
  }
  let text = req.input;
  if (req.json && !/json/i.test(text)) text += '\nRespond in valid JSON.';
  content.push({ type: 'input_text', text });

  const body: Record<string, unknown> = {
    model,
    instructions: req.system,
    input: [{ role: 'user', content }],
    max_output_tokens: req.maxTokens ?? 8000,
  };
  if (withTemperature) body.temperature = req.temperature ?? 0.3;
  if (req.json) body.text = { format: { type: 'json_object' } };
  return body;
}

export async function callOpenai(req: LLMRequest, apiKey: string, model: string): Promise<LLMResult> {
  const t0 = Date.now();
  const withTemperature = !modelsRejectingTemperature.has(model);

  let res: Response;
  try {
    res = await fetch(`${BASE}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildBody(req, model, withTemperature)),
    });
  } catch (e) {
    throw new AiError(`openai network error: ${(e as Error).message}`, true);
  }

  // temperature rejected by this model → learn it, retry once without the field
  if (res.status === 400 && withTemperature) {
    const errText = await res.text().catch(() => '');
    if (/temperature/i.test(errText)) {
      modelsRejectingTemperature.add(model);
      res = await fetch(`${BASE}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(buildBody(req, model, false)),
      });
    } else {
      throw new AiError(`openai ${model}: ${errText.slice(0, 300)}`, false, res.status);
    }
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
