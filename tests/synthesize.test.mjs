import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { synthesize, estimateCostUsd } from '../scripts/synthesize.mjs';
import { hasFfmpeg } from '../scripts/lib/audio.mjs';
import { SynthesisError } from '../scripts/lib/openai-tts.mjs';
import { fakeResponse, scriptedFetch, tmpHome, sentences, makeSineMp3 } from './helpers.mjs';

const NO_FFMPEG = { has: () => false, encode: () => { throw new Error('should not be called'); } };
const paragraphs = (n) => Array.from({ length: n }, (_, i) => `${String.fromCharCode(65 + i)}`.repeat(1000)).join('\n\n');

test('estimateCostUsd is 1.5 cents per audio minute', () => {
  assert.equal(estimateCostUsd(60), 0.015);
  assert.equal(estimateCostUsd(600), 0.15);
  assert.equal(estimateCostUsd(0), 0);
});

test('chunks are joined in script order even when later requests finish first', async () => {
  let n = 0;
  const f = scriptedFetch(async (_url, init) => {
    const idx = n++;
    await new Promise((r) => setTimeout(r, (4 - idx) * 15));
    return fakeResponse(200, `${JSON.parse(init.body).input[0]}|`);
  });
  const outPath = path.join(tmpHome(), 'a.mp3');
  const r = await synthesize({ text: paragraphs(4), outPath, apiKey: 'k', fetchImpl: f, ffmpeg: NO_FFMPEG });
  assert.equal(fs.readFileSync(outPath, 'utf8'), 'A|B|C|D|');
  assert.equal(r.chunks, 4);
  assert.equal(r.encoded, false);
});

test('without ffmpeg the native audio is written and duration is estimated from word count', async () => {
  const f = scriptedFetch(fakeResponse(200, 'AUDIO'));
  const outPath = path.join(tmpHome(), 'a.mp3');
  const text = sentences(300);
  const r = await synthesize({ text, outPath, apiKey: 'k', fetchImpl: f, ffmpeg: NO_FFMPEG });
  assert.equal(r.seconds, 120);
  assert.equal(r.costUsd, 0.03);
  assert.deepEqual(r.warnings, []);
});

test('a failed chunk aborts and no further chunks are requested', async () => {
  const f = scriptedFetch(fakeResponse(200, 'ok'), fakeResponse(401, 'bad key'), fakeResponse(200, 'ok'));
  await assert.rejects(
    synthesize({ text: paragraphs(5), outPath: path.join(tmpHome(), 'a.mp3'), apiKey: 'k', fetchImpl: f, concurrency: 1, ffmpeg: NO_FFMPEG }),
    (e) => e instanceof SynthesisError && e.status === 401,
  );
  assert.equal(f.calls.length, 2);
});

test('an empty script is rejected before any request', async () => {
  const f = scriptedFetch(fakeResponse(200, 'x'));
  await assert.rejects(synthesize({ text: '  ', outPath: path.join(tmpHome(), 'a.mp3'), apiKey: 'k', fetchImpl: f, ffmpeg: NO_FFMPEG }), /empty/);
  assert.equal(f.calls.length, 0);
});

test('a native file over 15 MB without ffmpeg produces a warning', async () => {
  const big = Buffer.alloc(16 * 1024 * 1024, 1);
  const f = scriptedFetch(fakeResponse(200, big));
  const r = await synthesize({ text: 'One sentence.', outPath: path.join(tmpHome(), 'a.mp3'), apiKey: 'k', fetchImpl: f, ffmpeg: NO_FFMPEG });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /ffmpeg/);
});

test('if ffmpeg exists but fails, the native file is kept and a warning is added', async () => {
  const f = scriptedFetch(fakeResponse(200, 'AUDIO'));
  const outPath = path.join(tmpHome(), 'a.mp3');
  const r = await synthesize({
    text: 'One sentence.', outPath, apiKey: 'k', fetchImpl: f,
    ffmpeg: { has: () => true, encode: () => { throw new Error('boom'); } },
  });
  assert.equal(r.encoded, false);
  assert.equal(fs.readFileSync(outPath, 'utf8'), 'AUDIO');
  assert.ok(r.warnings.some((w) => /boom/.test(w)));
  assert.equal(fs.existsSync(`${outPath}.raw.mp3`), false);
});

test('with real ffmpeg the output is re-encoded to 64 kbps mono', { skip: !hasFfmpeg() }, async () => {
  const dir = tmpHome();
  const sine = path.join(dir, 'sine.mp3');
  makeSineMp3(sine);
  const f = scriptedFetch(fakeResponse(200, fs.readFileSync(sine)));
  const outPath = path.join(dir, 'out.mp3');
  const r = await synthesize({ text: 'One sentence.', outPath, apiKey: 'k', fetchImpl: f });
  assert.equal(r.encoded, true);
  assert.ok(fs.statSync(outPath).size > 0);
  assert.ok(r.seconds >= 1 && r.seconds <= 2, `seconds=${r.seconds}`);
  assert.equal(fs.existsSync(`${outPath}.raw.mp3`), false);
});
