import fs from 'node:fs';
import path from 'node:path';
import { chunkText } from './lib/chunk.mjs';
import { synthesizeChunk } from './lib/openai-tts.mjs';
import { hasFfmpeg, encodeSpeech } from './lib/audio.mjs';
import { countWords } from './lib/validate-script.mjs';

const COST_PER_MINUTE_USD = 0.015;
const SPEECH_WORDS_PER_MINUTE = 150;
const ENCODED_BITRATE = 64000;
const NATIVE_WARN_BYTES = 15 * 1024 * 1024;

export function estimateCostUsd(seconds) {
  return Math.round((seconds / 60) * COST_PER_MINUTE_USD * 1000) / 1000;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function synthesize({
  text,
  outPath,
  apiKey,
  voice = 'marin',
  fetchImpl,
  sleep,
  concurrency = 3,
  maxChars = 1500,
  ffmpeg = { has: hasFfmpeg, encode: encodeSpeech },
}) {
  const chunks = chunkText(text, maxChars);
  if (!chunks.length) throw new Error('Nothing to synthesize: the script is empty.');
  const buffers = await mapPool(chunks, concurrency, (chunk) =>
    synthesizeChunk(chunk, { apiKey, voice, fetchImpl, sleep }),
  );
  const raw = Buffer.concat(buffers);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const warnings = [];
  let encoded = false;
  if (ffmpeg.has()) {
    const rawPath = `${outPath}.raw.mp3`;
    fs.writeFileSync(rawPath, raw);
    try {
      ffmpeg.encode(rawPath, outPath);
      encoded = true;
    } catch (err) {
      fs.writeFileSync(outPath, raw);
      warnings.push(`ffmpeg re-encode failed (${err.message}); kept the native audio`);
    } finally {
      fs.rmSync(rawPath, { force: true });
    }
  } else {
    fs.writeFileSync(outPath, raw);
    if (raw.length > NATIVE_WARN_BYTES) {
      warnings.push(`ffmpeg is not installed and the audio is ${(raw.length / 1048576).toFixed(1)} MB; install ffmpeg (brew install ffmpeg) to shrink it`);
    }
  }

  const bytes = fs.statSync(outPath).size;
  const seconds = encoded
    ? Math.round((bytes * 8) / ENCODED_BITRATE)
    : Math.round((countWords(text) / SPEECH_WORDS_PER_MINUTE) * 60);
  return { outPath, bytes, seconds, costUsd: estimateCostUsd(seconds), chunks: chunks.length, encoded, warnings };
}
