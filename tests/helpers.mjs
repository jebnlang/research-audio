import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-audio-'));
}

export function fakeResponse(status, body = '') {
  const buf = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
  };
}

export function scriptedFetch(...handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const h = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    const r = typeof h === 'function' ? await h(url, init) : h;
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

export const noSleep = async () => {};

export function sentences(wordCount) {
  return 'This is a sentence about research. '.repeat(Math.round(wordCount / 6)).trim();
}

export function makeSineMp3(file) {
  const r = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-codec:a', 'libmp3lame', file,
  ]);
  if (r.status !== 0) throw new Error('ffmpeg could not make a sine mp3');
}

export function setupHome({
  deliver = 'file',
  depth = 'deep',
  recipient = 'me@example.com',
  from = 'Research <audio@example.com>',
  openai = 'sk-test-OPENAI',
  resend = 're_test_RESEND',
} = {}) {
  const home = tmpHome();
  const outputDir = path.join(home, 'out');
  const cfg = { depth, deliver, voice: 'marin', outputDir };
  if (deliver === 'email') Object.assign(cfg, { recipient, from });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
  const lines = [];
  if (openai) lines.push(`OPENAI_API_KEY=${openai}`);
  if (resend) lines.push(`RESEND_API_KEY=${resend}`);
  fs.writeFileSync(path.join(home, 'env'), lines.join('\n') + '\n');
  return { env: { RESEARCH_AUDIO_HOME: home }, home, outputDir };
}
