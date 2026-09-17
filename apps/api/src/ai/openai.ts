import { AiError, type LLMRequest, type LLMResult } from './types.js';

const BASE = 'https://api.openai.com/v1';

/**
 * OpenAI — Responses API (current official API as of 2026-09).
 * POST /v1/responses with `instructions` + `input`, structured output via
 * `text.format = { type: "json_object" }` (verified live 2026-09-17: the API
 * rejects 'json'; supported values are 'json_object', 'text', 'json_schema').
 */
/** Models that reject `temperature` (reasoning-family, e.g. gpt-5.6-*). Learned at runtime from the API. */
const NO_TEMPERATURE = new Set<string>();

async function postResponses(
  body: Record<string, unknown>,
  apiKey: string,
): Promise<{ res: Response; data: any }> {
  const res = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  return { res, data };
}

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

  const buildBody = (withTemp: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model,
      instructions: req.system,
      input: [{ role: 'user', content }],
      max_output_tokens: req.maxTokens ?? 8000,
    };
    if (withTemp) body.temperature = req.temperature ?? 0.3;
    if (req.json) {
      body.text = { format: { type: 'json_object' } };
      // The Responses API requires the literal word "json" (lowercase) in the
      // input messages when using json_object mode — prompts say "JSON".
      const hasJson = /json/.test(req.input) || /json/.test(req.system);
      if (!hasJson) content[content.length - 1].text += '\n(Respond in json.)';
    }
    return body;
  };

  let res: Response;
  let data: any;
  try {
    const first = !NO_TEMPERATURE.has(model);
    ({ res, data } = await postResponses(buildBody(first), apiKey));
    // Reasoning-family models reject `temperature` — learn it and retry once.
    if (!res.ok && first && res.status === 400 && /temperature/i.test(String(data?.error?.message ?? ''))) {
      NO_TEMPERATURE.add(model);
      ({ res, data } = await postResponses(buildBody(false), apiKey));
    }
  } catch (e) {
    throw new AiError(`openai network error: ${(e as Error).message}`, true);
  }

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
