#!/usr/bin/env node
/**
 * openai-client-check — openai.ts live-API contract regression (mocked fetch, no network).
 *
 * Locks in the behaviors discovered against the real API on 2026-09-17 (E2E 3ac66526):
 *
 *   1. json mode      → sends text.format.type = 'json_object' (the API rejects 'json')
 *   2. json-word guard→ json_object mode requires literal lowercase "json" in input;
 *                       client appends it when missing, and not when already present
 *   3. temperature    → gpt-5.6-* rejects it: 400 → retry once WITHOUT temperature,
 *                       model learned (subsequent calls never send it again)
 *   4. success path   → output_text parsed, JSON extracted, provider/model/latency set
 *   5. image input    → base64 frames sent as input_image data-URLs
 *   6. errors         → 429 retryable, 400 non-retryable, message includes model
 */
import { callOpenai } from '../dist/ai/openai.js';

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

const KEY = 'sk-test';
const calls = [];
let responder;

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  return responder(body);
};

const okResp = (text) => jsonResponse(200, { output_text: text });
const JSON_REPLY = '{"scene":"test","energy":7}';

try {
  /* 1. json_object, never 'json' */
  calls.length = 0;
  responder = () => okResp(JSON_REPLY);
  await callOpenai(
    { system: 'Respond with JSON only: {"a":1}.', input: 'Analyze this frame.', json: true, maxTokens: 100 },
    KEY,
    'gpt-5.6-luna',
  );
  const b1 = calls[0].body;
  check('json mode sends json_object', b1.text?.format?.type === 'json_object', JSON.stringify(b1.text));
  check('json mode never sends type "json"', b1.text?.format?.type !== 'json');
  check('fresh model: temperature sent by default', b1.temperature === 0.3, String(b1.temperature));

  /* 2. json-word guard */
  calls.length = 0;
  responder = () => okResp(JSON_REPLY);
  await callOpenai(
    { system: 'You are a video editor. Respond with JSON only.', input: 'Analyze this frame.', json: true },
    KEY,
    'test-model-jsonword',
  );
  const text1 = calls[0].body.input[0].content.find((c) => c.type === 'input_text').text;
  check('appends lowercase "json" when missing', /json/.test(text1) && text1.endsWith('(Respond in json.)'), text1.slice(-60));

  calls.length = 0;
  await callOpenai(
    { system: 'You are a video editor.', input: 'Return a json object.', json: true },
    KEY,
    'test-model-jsonword',
  );
  const text2 = calls[0].body.input[0].content.find((c) => c.type === 'input_text').text;
  check('does not append when "json" already present', text2 === 'Return a json object.', text2);

  /* 3. temperature: 400 → retry without, then learned */
  const tempModel = 'test-model-temperature';
  calls.length = 0;
  responder = (body) =>
    'temperature' in body
      ? jsonResponse(400, { error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } })
      : okResp(JSON_REPLY);
  const r3 = await callOpenai(
    { system: 'You are a video editor. Respond with JSON only.', input: 'Analyze this frame.', json: true },
    KEY,
    tempModel,
  );
  check('temperature 400 → succeeded after retry', r3.json?.scene === 'test', JSON.stringify(r3.json));
  check('retry chain: first with temp, second without', calls.length === 2 && 'temperature' in calls[0].body && !('temperature' in calls[1].body), `calls=${calls.length}`);
  calls.length = 0;
  await callOpenai(
    { system: 'You are a video editor. Respond with JSON only.', input: 'Analyze this frame.', json: true },
    KEY,
    tempModel,
  );
  check('learned model: subsequent call omits temperature (no retry)', calls.length === 1 && !('temperature' in calls[0].body), `calls=${calls.length}`);

  /* 4. success path */
  calls.length = 0;
  responder = () => okResp(JSON_REPLY);
  const r4 = await callOpenai(
    { system: 'You are a video editor. Respond with JSON only.', input: 'Analyze this frame.', json: true },
    KEY,
    'test-model-success',
  );
  check('parses JSON + provider/model/latency', r4.json?.energy === 7 && r4.provider === 'openai' && r4.model === 'test-model-success' && r4.latencyMs >= 0, JSON.stringify(r4));
  const r4b = await callOpenai({ system: 'Be terse.', input: 'Say hi.' }, KEY, 'test-model-success');
  check('text mode: text set, json null', typeof r4b.text === 'string' && r4b.json === null, JSON.stringify(r4b));

  /* 5. image input */
  calls.length = 0;
  responder = () => okResp(JSON_REPLY);
  await callOpenai(
    { system: 'Respond with JSON only.', input: 'Describe.', json: true, images: [{ data: 'QUJD', mimeType: 'image/png' }] },
    KEY,
    'test-model-images',
  );
  const content = calls[0].body.input[0].content;
  const img = content.find((c) => c.type === 'input_image');
  check('image sent as input_image data-URL', img?.image_url === 'data:image/png;base64,QUJD', img?.image_url);
  check('text part still present', content.some((c) => c.type === 'input_text'));

  /* 6. errors */
  calls.length = 0;
  responder = () => jsonResponse(429, { error: { message: 'Rate limited' } });
  let err = null;
  try {
    await callOpenai({ system: 'x', input: 'y' }, KEY, 'test-model-errors');
  } catch (e) {
    err = e;
  }
  check('429 → retryable AiError', err?.retryable === true && /rate limited/i.test(err.message), err?.message);
  calls.length = 0;
  responder = () => jsonResponse(400, { error: { message: 'bad model name' } });
  err = null;
  try {
    await callOpenai({ system: 'x', input: 'y' }, KEY, 'test-model-errors2');
  } catch (e) {
    err = e;
  }
  check('400 → non-retryable, message names model', err?.retryable === false && /test-model-errors2/.test(err.message), err?.message);
} finally {
  delete globalThis.fetch;
}

console.log(`\nopenai-client-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
