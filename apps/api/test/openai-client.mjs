#!/usr/bin/env node
/**
 * openai-client — locks in the LIVE OpenAI Responses API contract
 * (verified against api.openai.com 2026-09-17). 14/14 must PASS.
 *
 *   1. posts to /v1/responses with the configured model
 *   2. json:true      → text.format.type = "json_object" (NOT "json" — 400)
 *   3. json guard     → input lacking lowercase "json" gets "Respond in valid JSON." appended
 *   4. json guard off → input already containing "json" is left untouched
 *   5. json:false     → no text.format field at all
 *   6. temperature    → sent by default for an unlearned model
 *   7. temp rejected  → 400 mentioning temperature ⇒ model learned, retried WITHOUT it, succeeds
 *   8. temp learned   → next call for same model sends no temperature from the start
 *   9. per-model      → learning is per-model: a different model still sends temperature
 *  10. other 400      → non-temperature 400 throws AiError (no silent retry)
 *  11. 429            → retryable AiError
 *  12. 500            → retryable AiError
 *  13. success text   → output_text returned, provider/model stamped
 *  14. success json   → fenced/loose JSON parsed via parseJson
 *  15. image data URL → input_image uses "data:<mime>;base64,<b64>" (live 400
 *                       "without the ',' separator" proves the comma is required)
 *
 * Mocks global fetch — no network, no key needed.
 */
import { callOpenai, _resetTemperatureLearning } from '../dist/ai/openai.js';
import { AiError } from '../dist/ai/types.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// fetch mock harness: queued responses (Response-like), captures request bodies
let captured = [];
let queued = [];
let realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  captured.push({ url: String(url), body });
  const next = queued.shift() ?? okResponse('{"ok": true}');
  return next;
};

function okResponse(payload, { outputText } = {}) {
  const data = {
    output_text: outputText !== undefined ? outputText : String(payload),
    output: [],
  };
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}
function errResponse(status, message) {
  const msg = message ?? 'error';
  return {
    ok: false,
    status,
    json: async () => ({ error: { message: msg } }),
    text: async () => JSON.stringify({ error: { message: msg } }),
  };
}

const KEY = 'sk-test';
const MODEL = 'gpt-5.6-luna';
const req = (over = {}) => ({
  task: 'plan',
  system: 'You are an editor.',
  input: over.input ?? 'Pick the moments.',
  json: over.json ?? false,
  temperature: over.temperature ?? 0.3,
});

try {
  // ── 1. endpoint + model ─────────────────────────────────────────────
  queued = [okResponse('{"a":1}')];
  captured = [];
  await callOpenai(req(), KEY, MODEL);
  check(
    'posts to /v1/responses with the configured model',
    captured[0]?.url.endsWith('/v1/responses') && captured[0]?.body?.model === MODEL,
    `${captured[0]?.url} ${captured[0]?.body?.model}`,
  );

  // ── 2. json_object format ───────────────────────────────────────────
  queued = [okResponse('{"a":1}')];
  captured = [];
  await callOpenai(req({ json: true }), KEY, MODEL);
  check(
    'json:true → text.format.type = "json_object"',
    captured[0]?.body?.text?.format?.type === 'json_object',
    JSON.stringify(captured[0]?.body?.text),
  );

  // ── 3. lowercase-json input guard ───────────────────────────────────
  queued = [okResponse('{"a":1}')];
  captured = [];
  await callOpenai(req({ json: true, input: 'Pick the moments.' }), KEY, MODEL);
  const inputText =
    captured[0]?.body?.input?.[0]?.content?.find((c) => c.type === 'input_text')?.text ?? '';
  check(
    'input lacking "json" gets JSON instruction appended',
    /respond in valid json\./i.test(inputText),
    JSON.stringify(inputText),
  );

  // ── 4. guard does not double-add ────────────────────────────────────
  queued = [okResponse('{"a":1}')];
  captured = [];
  await callOpenai(req({ json: true, input: 'Return JSON only.' }), KEY, MODEL);
  const inputText2 =
    captured[0]?.body?.input?.[0]?.content?.find((c) => c.type === 'input_text')?.text ?? '';
  check(
    'input already containing "json" left untouched',
    inputText2 === 'Return JSON only.',
    JSON.stringify(inputText2),
  );

  // ── 5. no format field when json:false ──────────────────────────────
  queued = [okResponse('{"a":1}')];
  captured = [];
  await callOpenai(req({ json: false }), KEY, MODEL);
  check('json:false → no text.format', !('text' in (captured[0]?.body ?? {})));

  // ── 6. temperature sent by default ──────────────────────────────────
  _resetTemperatureLearning();
  queued = [okResponse('{"a":1}')];
  captured = [];
  await callOpenai(req({ temperature: 0.3 }), KEY, 'gpt-5.6-luna');
  check(
    'temperature sent for unlearned model',
    captured[0]?.body?.temperature === 0.3,
    JSON.stringify(captured[0]?.body?.temperature),
  );

  // ── 7. temperature rejected → learn + retry without it ──────────────
  _resetTemperatureLearning();
  queued = [
    errResponse(400, "Unsupported value: 'temperature' is not supported with this model."),
    okResponse('{"a":2}'),
  ];
  captured = [];
  const r7 = await callOpenai(req({ temperature: 0.3 }), KEY, MODEL);
  check('temp 400 → retried without temperature, succeeds', captured.length === 2 && captured[1]?.body?.temperature === undefined && r7.text === '{"a":2}', `calls=${captured.length}`);

  // ── 8. learned model skips temperature from the start ───────────────
  queued = [okResponse('{"a":3}')];
  captured = [];
  await callOpenai(req({ temperature: 0.3 }), KEY, MODEL);
  check(
    'learned model sends no temperature (single call)',
    captured.length === 1 && captured[0]?.body?.temperature === undefined,
  );

  // ── 9. learning is per-model ────────────────────────────────────────
  queued = [okResponse('{"a":4}')];
  captured = [];
  await callOpenai(req({ temperature: 0.2 }), KEY, 'gpt-5.6-terra');
  check(
    'different model still sends temperature',
    captured[0]?.body?.temperature === 0.2,
    JSON.stringify(captured[0]?.body?.temperature),
  );

  // ── 10. non-temperature 400 throws (no silent retry) ────────────────
  _resetTemperatureLearning();
  queued = [errResponse(400, "Invalid value for 'max_output_tokens'")];
  captured = [];
  let threw10 = null;
  try {
    await callOpenai(req(), KEY, 'gpt-5.6-luna');
  } catch (e) {
    threw10 = e;
  }
  check(
    'other 400 → AiError, exactly one call',
    threw10 instanceof AiError && captured.length === 1,
    `${threw10?.message} calls=${captured.length}`,
  );

  // ── 11. 429 retryable ───────────────────────────────────────────────
  queued = [errResponse(429, 'Rate limited')];
  let err11 = null;
  try {
    await callOpenai(req(), KEY, MODEL);
  } catch (e) {
    err11 = e;
  }
  check('429 → retryable AiError', err11 instanceof AiError && err11.retryable === true, String(err11?.retryable));

  // ── 12. 500 retryable ───────────────────────────────────────────────
  queued = [errResponse(500, 'boom')];
  let err12 = null;
  try {
    await callOpenai(req(), KEY, MODEL);
  } catch (e) {
    err12 = e;
  }
  check('500 → retryable AiError', err12 instanceof AiError && err12.retryable === true, String(err12?.retryable));

  // ── 13. success: output_text + stamps ───────────────────────────────
  queued = [okResponse('{"x":1}', { outputText: 'hello there' })];
  const r13 = await callOpenai(req(), KEY, MODEL);
  check(
    'success → output_text, provider/model stamped',
    r13.text === 'hello there' && r13.provider === 'openai' && r13.model === MODEL && r13.latencyMs >= 0,
    JSON.stringify({ t: r13.text, p: r13.provider }),
  );

  // ── 14. success: fenced JSON parsed ─────────────────────────────────
  queued = [okResponse('{"y":2}', { outputText: '```json\n{"clip": 1}\n```' })];
  const r14 = await callOpenai(req({ json: true }), KEY, MODEL);
  check('success json → fenced payload parsed', r14.json?.clip === 1, JSON.stringify(r14.json));

  // ── 15. image data URL has the comma separator ──────────────────────
  queued = [okResponse('{"z":6}')];
  captured = [];
  await callOpenai(
    { ...req(), images: [{ data: 'QUJD', mimeType: 'image/jpeg' }] },
    KEY,
    MODEL,
  );
  const imgUrl =
    captured[0]?.body?.input?.[0]?.content?.find((c) => c.type === 'input_image')?.image_url ?? '';
  check(
    'image → data URL with comma separator',
    imgUrl === 'data:image/jpeg;base64,QUJD',
    imgUrl,
  );
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\nopenai-client: ${pass}/15 pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
