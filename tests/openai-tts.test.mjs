import test from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesizeChunk, SynthesisError, TTS_URL, DEFAULT_MODEL, TONE_INSTRUCTIONS,
} from '../scripts/lib/openai-tts.mjs';
import { fakeResponse, scriptedFetch } from './helpers.mjs';

const recorder = () => {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
};

test('sends model, voice, tone instruction and key, and returns the audio bytes', async () => {
  const f = scriptedFetch(fakeResponse(200, 'MP3DATA'));
  const out = await synthesizeChunk('Hello there.', { apiKey: 'sk-secret', fetchImpl: f, sleep: async () => {} });
  assert.equal(out.toString(), 'MP3DATA');
  const { url, init } = f.calls[0];
  assert.equal(url, TTS_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer sk-secret');
  assert.deepEqual(JSON.parse(init.body), {
    model: DEFAULT_MODEL,
    voice: 'marin',
    input: 'Hello there.',
    instructions: TONE_INSTRUCTIONS,
    response_format: 'mp3',
  });
});

test('the tone instruction is the agreed one', () => {
  assert.equal(
    TONE_INSTRUCTIONS,
    'Speak as a calm, clear briefing narrator. Warm, steady pace, natural pauses between paragraphs, no theatrics.',
  );
});

test('retries a 429 with backoff and then succeeds', async () => {
  const { waits, sleep } = recorder();
  const f = scriptedFetch(fakeResponse(429, 'slow down'), fakeResponse(429, 'slow down'), fakeResponse(200, 'OK'));
  const out = await synthesizeChunk('x', { apiKey: 'k', fetchImpl: f, sleep });
  assert.equal(out.toString(), 'OK');
  assert.equal(f.calls.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('retries a network error', async () => {
  const { sleep } = recorder();
  const f = scriptedFetch(new TypeError('fetch failed'), fakeResponse(200, 'OK'));
  const out = await synthesizeChunk('x', { apiKey: 'k', fetchImpl: f, sleep });
  assert.equal(out.toString(), 'OK');
  assert.equal(f.calls.length, 2);
});

test('gives up after three retries (four attempts) on persistent 503', async () => {
  const { waits, sleep } = recorder();
  const f = scriptedFetch(fakeResponse(503, 'down'));
  await assert.rejects(
    synthesizeChunk('x', { apiKey: 'k', fetchImpl: f, sleep }),
    (e) => e instanceof SynthesisError && e.status === 503 && e.retryable === true,
  );
  assert.equal(f.calls.length, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('401 is never retried', async () => {
  const f = scriptedFetch(fakeResponse(401, 'bad key'));
  await assert.rejects(
    synthesizeChunk('x', { apiKey: 'k', fetchImpl: f, sleep: async () => {} }),
    (e) => e instanceof SynthesisError && e.status === 401 && e.retryable === false,
  );
  assert.equal(f.calls.length, 1);
});

test('other 4xx is not retried and carries the server message', async () => {
  const f = scriptedFetch(fakeResponse(400, '{"error":"input too long"}'));
  await assert.rejects(
    synthesizeChunk('x', { apiKey: 'k', fetchImpl: f, sleep: async () => {} }),
    (e) => e.status === 400 && /input too long/.test(e.message),
  );
  assert.equal(f.calls.length, 1);
});

test('REVIEW FOCUS: the API key never appears in error text, even if the provider echoes it', async () => {
  const key = 'sk-proj-ABCDEF1234567890';
  for (const res of [fakeResponse(401, `Incorrect API key provided: ${key}`), fakeResponse(400, `bad request for ${key}`)]) {
    const f = scriptedFetch(res);
    await assert.rejects(
      synthesizeChunk('x', { apiKey: key, fetchImpl: f, sleep: async () => {} }),
      (e) => !e.message.includes(key),
    );
  }
});
