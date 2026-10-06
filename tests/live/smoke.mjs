// Opt-in: makes one real OpenAI request (about one sentence, under one cent).
// Run: RESEARCH_AUDIO_LIVE=1 OPENAI_API_KEY=... node tests/live/smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { synthesize } from '../../scripts/synthesize.mjs';

if (process.env.RESEARCH_AUDIO_LIVE !== '1') {
  console.log('Skipped: set RESEARCH_AUDIO_LIVE=1 to run (costs under one cent).');
  process.exit(0);
}
assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY must be set in the shell');

const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ra-live-')), 'smoke.mp3');
const r = await synthesize({
  text: 'This is a short live check of the research audio plugin.',
  outPath,
  apiKey: process.env.OPENAI_API_KEY,
});
const head = fs.readFileSync(outPath).subarray(0, 3);
const looksLikeMp3 = head.toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
assert.ok(r.bytes > 1000, `audio too small: ${r.bytes} bytes`);
assert.ok(looksLikeMp3, 'output does not start like an MP3');
console.log(`OK: ${r.bytes} bytes, about ${r.seconds}s, encoded=${r.encoded}, file ${outPath}`);
