# research-audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin that, at the end of a research session, writes a spoken summary at the user's saved depth, turns it into an MP3 with OpenAI TTS, and delivers it by email (Resend) or as a saved file.

**Architecture:** Two slash commands (`setup`, `send`) and one skill (how to write for the ear) drive a set of small zero-dependency Node ESM scripts. Claude writes the script text; plain code does validation, chunked synthesis, re-encoding and delivery. Config lives outside the repo in `~/.config/research-audio/`.

**Tech Stack:** Node 20+ (verified on 24.18.1), ESM `.mjs`, built-in `fetch`, `node:test`, optional `ffmpeg`. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-research-audio-design.md`

## Global Constraints

- Repo: `~/Documents/Code/research-audio`, work on `main` only, no branches.
- Zero npm dependencies. All scripts are ESM `.mjs`. Tests: `node --test tests/*.test.mjs`.
- Voice: OpenAI model `gpt-4o-mini-tts`, voice `marin`, `response_format: "mp3"`.
- Tone instruction sent with every chunk, verbatim: `Speak as a calm, clear briefing narrator. Warm, steady pace, natural pauses between paragraphs, no theatrics.`
- Depth targets (words, spoken at about 150 words/min): concise 400, deep 1200, deeper 3000; accepted range is target ±25%.
- Chunks: at most 1500 characters, split at paragraph breaks, then sentence ends, never mid-sentence unless one sentence alone exceeds the cap. Up to 3 requests in flight.
- Retries: 3 retries (4 attempts) on 429, 5xx and network errors, waits 1000/2000/4000 ms. 401/403 and other 4xx are never retried.
- Audio output: 64 kbps mono MP3 via `ffmpeg`. Without `ffmpeg`, keep the native MP3 and warn if over 15 MB.
- Email: Resend `POST https://api.resend.com/emails`, MP3 as base64 attachment. Over 20 MB, or any Resend failure, falls back to file mode and says why. The script is also in the email body as text.
- Config dir `~/.config/research-audio/` (override with `RESEARCH_AUDIO_HOME`): `config.json` (non-secret) and `env` (secrets, mode 0600). Secrets are never asked for in chat, never printed, never in error text.
- Delivery modes are exactly `email` and `file`. Depths are exactly `concise`, `deep`, `deeper`.
- Output of every script is one JSON object on stdout; exit codes: 0 ok, 1 error, 2 script failed validation.

## Review Focus

Failure modes the spec implies but that no single feature test would catch. Each has a pinning test in the task named.

1. A pasted URL or other long unbroken token in the script must not push a chunk over the 1500-character cap or crash the chunker (Task 2).
2. A topic made only of emoji, Hebrew, slashes or dots must still produce a safe, non-empty run folder name, and a second run of the same topic on the same day must not overwrite the first audio (Task 7).
3. Email mode with no Resend key must fail at `--init`, before Claude writes a script and before any OpenAI spend (Task 7).
4. A topic containing a newline must not be able to inject an email header through the subject (Task 6).
5. API error text must never contain the API key, even when the provider echoes it back in an error body (Task 4).

---

## File Structure

```
package.json
.gitignore
README.md
.claude-plugin/plugin.json
commands/setup.md
commands/send.md
skills/research-audio/SKILL.md
scripts/lib/config.mjs          config + secrets loading and validation
scripts/lib/chunk.mjs           text -> chunks <= cap
scripts/lib/validate-script.mjs depth targets, markdown/URL checks
scripts/lib/openai-tts.mjs      one chunk -> MP3 bytes, with retry
scripts/lib/audio.mjs           ffmpeg detection + encode
scripts/synthesize.mjs          chunk, voice, join, encode, cost
scripts/deliver.mjs             email via Resend or file, with fallbacks
scripts/send.mjs                CLI for the send command: init / check / send
scripts/setup.mjs               CLI for the setup command
tests/helpers.mjs
tests/*.test.mjs
tests/live/smoke.mjs            opt-in, costs under one cent
```

---

### Task 1: Scaffold and config

**Files:**
- Create: `package.json`, `.gitignore`, `.claude-plugin/plugin.json`
- Create: `scripts/lib/config.mjs`
- Create: `tests/helpers.mjs`
- Test: `tests/config.test.mjs`

**Interfaces:**
- Produces (`config.mjs`):
  - `DEPTHS = ['concise','deep','deeper']`, `DELIVERY_MODES = ['email','file']`, `SECRET_KEYS = ['OPENAI_API_KEY','RESEND_API_KEY']`
  - `DEFAULTS = { depth:'deep', deliver:'file', voice:'marin', outputDir:<~/research-audio> }`
  - `class ConfigError extends Error`
  - `configDir(env=process.env): string`
  - `parseEnvFile(text): Record<string,string>`
  - `validateConfig(cfg): string[]` (empty = valid)
  - `loadConfig(env=process.env): cfg` (validated, `~` expanded; throws `ConfigError`)
  - `saveConfig(cfg, env=process.env): string` (returns the file path)
  - `applyOverrides(cfg, {depth, deliver}): cfg` (re-validates; throws `ConfigError`)
  - `loadSecrets(env=process.env): { OPENAI_API_KEY, RESEND_API_KEY }` (empty string when absent; process env wins over the file)
  - `requiredSecrets(cfg): string[]`
  - `requireSecrets(cfg, secrets, env=process.env): void` (throws `ConfigError` naming only the missing keys)
- Produces (`tests/helpers.mjs`):
  - `tmpHome(): string`
  - `fakeResponse(status, body?): Response-like` (`ok`, `status`, `arrayBuffer()`, `text()`, `json()`)
  - `scriptedFetch(...handlers): fetch-like` with `.calls = [{url, init}]`; each handler is a response, an `Error` (thrown), or `(url, init) => response`; the last handler repeats
  - `noSleep`
  - `sentences(wordCount): string` (six-word sentences)
  - `makeSineMp3(file): void` (needs ffmpeg)
  - `setupHome({deliver, depth, recipient, from, openai, resend}): { env, home, outputDir }` (writes a valid `config.json` and `env` file into a temp dir; `env` is `{RESEARCH_AUDIO_HOME: home}` only, so tests never see real keys)

- [ ] **Step 1: Write the scaffold files**

`package.json`:
```json
{
  "name": "research-audio",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test tests/*.test.mjs" },
  "engines": { "node": ">=20" }
}
```

`.gitignore`:
```
node_modules
.DS_Store
*.mp3
```

`.claude-plugin/plugin.json`:
```json
{
  "name": "research-audio",
  "version": "0.1.0",
  "description": "Turns a research session into a spoken summary (MP3) at a depth you choose once, and delivers it by email or as a file so you can listen on your phone.",
  "author": { "name": "Ben Lang" },
  "keywords": ["research", "audio", "tts", "summary", "email"]
}
```

`tests/helpers.mjs`:
```js
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
```

- [ ] **Step 2: Write the failing config tests**

`tests/config.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigError, DEFAULTS, parseEnvFile, validateConfig, loadConfig, saveConfig,
  applyOverrides, loadSecrets, requiredSecrets, requireSecrets, configDir,
} from '../scripts/lib/config.mjs';
import { tmpHome, setupHome } from './helpers.mjs';

test('parseEnvFile reads KEY=VALUE, skips comments, strips quotes, keeps = inside values', () => {
  const out = parseEnvFile('# c\nA=1\nB="two"\n\nC=x=y\n  D = spaced \n');
  assert.deepEqual(out, { A: '1', B: 'two', C: 'x=y', D: 'spaced' });
});

test('configDir honours RESEARCH_AUDIO_HOME', () => {
  assert.equal(configDir({ RESEARCH_AUDIO_HOME: '/x/y' }), '/x/y');
  assert.equal(configDir({}), path.join(os.homedir(), '.config', 'research-audio'));
});

test('validateConfig accepts a good file-mode config', () => {
  assert.deepEqual(validateConfig({ ...DEFAULTS }), []);
});

test('validateConfig rejects a bad depth and a bad delivery mode', () => {
  const problems = validateConfig({ ...DEFAULTS, depth: 'epic', deliver: 'pigeon' });
  assert.ok(problems.some((p) => p.includes('depth')));
  assert.ok(problems.some((p) => p.includes('deliver')));
});

test('email mode needs a recipient and a from address; file mode does not', () => {
  const problems = validateConfig({ ...DEFAULTS, deliver: 'email' });
  assert.ok(problems.some((p) => p.includes('recipient')));
  assert.ok(problems.some((p) => p.includes('from')));
  assert.deepEqual(
    validateConfig({ ...DEFAULTS, deliver: 'email', recipient: 'a@b.co', from: 'Me <m@b.co>' }),
    [],
  );
});

test('loadConfig throws a ConfigError pointing at setup when nothing is saved', () => {
  const env = { RESEARCH_AUDIO_HOME: tmpHome() };
  assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && /setup/.test(e.message));
});

test('loadConfig merges defaults and expands ~ in outputDir', () => {
  const env = { RESEARCH_AUDIO_HOME: tmpHome() };
  fs.writeFileSync(path.join(env.RESEARCH_AUDIO_HOME, 'config.json'), JSON.stringify({ depth: 'concise', outputDir: '~/audio' }));
  const cfg = loadConfig(env);
  assert.equal(cfg.depth, 'concise');
  assert.equal(cfg.voice, 'marin');
  assert.equal(cfg.outputDir, path.join(os.homedir(), 'audio'));
});

test('loadConfig reports invalid JSON as a ConfigError', () => {
  const env = { RESEARCH_AUDIO_HOME: tmpHome() };
  fs.writeFileSync(path.join(env.RESEARCH_AUDIO_HOME, 'config.json'), '{nope');
  assert.throws(() => loadConfig(env), ConfigError);
});

test('saveConfig then loadConfig round-trips', () => {
  const env = { RESEARCH_AUDIO_HOME: path.join(tmpHome(), 'nested') };
  saveConfig({ ...DEFAULTS, depth: 'deeper' }, env);
  assert.equal(loadConfig(env).depth, 'deeper');
});

test('applyOverrides re-validates: switching to email without a recipient fails', () => {
  assert.throws(() => applyOverrides({ ...DEFAULTS }, { deliver: 'email' }), ConfigError);
  assert.equal(applyOverrides({ ...DEFAULTS }, { depth: 'concise' }).depth, 'concise');
});

test('loadSecrets lets the process env win over the file and ignores empty values', () => {
  const { env } = setupHome({ openai: 'from-file', resend: 'resend-file' });
  const secrets = loadSecrets({ ...env, OPENAI_API_KEY: 'from-shell', RESEND_API_KEY: '' });
  assert.equal(secrets.OPENAI_API_KEY, 'from-shell');
  assert.equal(secrets.RESEND_API_KEY, 'resend-file');
});

test('requireSecrets names only the missing keys, and file mode does not need Resend', () => {
  const { env } = setupHome({ deliver: 'email', resend: '' });
  const secrets = loadSecrets(env);
  const cfg = { ...DEFAULTS, deliver: 'email', recipient: 'a@b.co', from: 'a@b.co' };
  assert.throws(() => requireSecrets(cfg, secrets, env), (e) => /RESEND_API_KEY/.test(e.message) && !/OPENAI_API_KEY/.test(e.message));
  assert.deepEqual(requiredSecrets({ ...DEFAULTS, deliver: 'file' }), ['OPENAI_API_KEY']);
  assert.doesNotThrow(() => requireSecrets({ ...DEFAULTS, deliver: 'file' }, secrets, env));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/Documents/Code/research-audio && node --test tests/config.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/lib/config.mjs'`

- [ ] **Step 4: Write the implementation**

`scripts/lib/config.mjs`:
```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEPTHS = ['concise', 'deep', 'deeper'];
export const DELIVERY_MODES = ['email', 'file'];
export const SECRET_KEYS = ['OPENAI_API_KEY', 'RESEND_API_KEY'];
export const DEFAULTS = {
  depth: 'deep',
  deliver: 'file',
  voice: 'marin',
  outputDir: path.join(os.homedir(), 'research-audio'),
};

export class ConfigError extends Error {}

export function configDir(env = process.env) {
  return env.RESEARCH_AUDIO_HOME || path.join(os.homedir(), '.config', 'research-audio');
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function validateConfig(cfg) {
  const problems = [];
  if (!DEPTHS.includes(cfg.depth)) problems.push(`depth must be one of ${DEPTHS.join(', ')} (got "${cfg.depth}")`);
  if (!DELIVERY_MODES.includes(cfg.deliver)) problems.push(`deliver must be one of ${DELIVERY_MODES.join(', ')} (got "${cfg.deliver}")`);
  if (cfg.deliver === 'email') {
    if (!/^[^@\s]+@[^@\s]+$/.test(cfg.recipient || '')) problems.push('email delivery needs a valid "recipient" address');
    if (!/@/.test(cfg.from || '')) problems.push('email delivery needs a "from" address');
  }
  if (!cfg.outputDir || typeof cfg.outputDir !== 'string') problems.push('outputDir is required');
  if (!cfg.voice) problems.push('voice is required');
  return problems;
}

export function loadConfig(env = process.env) {
  const file = path.join(configDir(env), 'config.json');
  if (!fs.existsSync(file)) {
    throw new ConfigError('research-audio is not set up yet. Run /research-audio:setup first.');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err.message}`);
  }
  const cfg = { ...DEFAULTS, ...parsed };
  cfg.outputDir = expandHome(cfg.outputDir);
  const problems = validateConfig(cfg);
  if (problems.length) throw new ConfigError(`${file}: ${problems.join('; ')}`);
  return cfg;
}

export function saveConfig(cfg, env = process.env) {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return file;
}

export function applyOverrides(cfg, { depth, deliver } = {}) {
  const merged = { ...cfg };
  if (depth) merged.depth = depth;
  if (deliver) merged.deliver = deliver;
  const problems = validateConfig(merged);
  if (problems.length) throw new ConfigError(problems.join('; '));
  return merged;
}

export function loadSecrets(env = process.env) {
  const file = path.join(configDir(env), 'env');
  const fromFile = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : {};
  const out = {};
  for (const key of SECRET_KEYS) out[key] = (env[key] || '').trim() || (fromFile[key] || '').trim();
  return out;
}

export function requiredSecrets(cfg) {
  return cfg.deliver === 'email' ? [...SECRET_KEYS] : ['OPENAI_API_KEY'];
}

export function requireSecrets(cfg, secrets, env = process.env) {
  const missing = requiredSecrets(cfg).filter((k) => !secrets[k]);
  if (missing.length) {
    const file = path.join(configDir(env), 'env');
    throw new ConfigError(
      `Missing ${missing.join(' and ')}. Add ${missing.length > 1 ? 'them' : 'it'} to ${file} as KEY=value lines. Never paste keys into chat.`,
    );
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/Documents/Code/research-audio && node --test tests/config.test.mjs`
Expected: PASS, 12 tests

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/Code/research-audio
git add package.json .gitignore .claude-plugin scripts tests
git commit -m "feat: scaffold plugin and config/secrets loading"
```

---

### Task 2: Text chunker

**Files:**
- Create: `scripts/lib/chunk.mjs`
- Test: `tests/chunk.test.mjs`

**Interfaces:**
- Consumes: `sentences()` from `tests/helpers.mjs`
- Produces: `chunkText(text: string, maxChars = 1500): string[]` (never returns an empty chunk; every chunk is at most `maxChars` characters)

- [ ] **Step 1: Write the failing tests**

`tests/chunk.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../scripts/lib/chunk.mjs';
import { sentences } from './helpers.mjs';

const norm = (s) => s.replace(/\s+/g, ' ').trim();

test('empty or whitespace-only text gives no chunks', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('  \n\n  '), []);
});

test('short text is a single chunk', () => {
  assert.deepEqual(chunkText('Hello there.\n\nSecond paragraph.'), ['Hello there.\n\nSecond paragraph.']);
});

test('paragraph breaks are the preferred boundary', () => {
  const a = 'A'.repeat(900);
  const b = 'B'.repeat(900);
  assert.deepEqual(chunkText(`${a}\n\n${b}`), [a, b]);
});

test('an over-long paragraph splits at sentence ends, never mid-sentence', () => {
  const text = sentences(1000);
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 1500, `chunk of ${c.length} chars`);
    assert.ok(c.endsWith('.'), `chunk does not end at a sentence: ...${c.slice(-20)}`);
  }
  assert.equal(norm(chunks.join(' ')), norm(text));
});

test('a long run of words with no punctuation still respects the cap', () => {
  const text = 'word '.repeat(400).trim();
  const chunks = chunkText(text);
  for (const c of chunks) assert.ok(c.length <= 1500);
  assert.equal(norm(chunks.join(' ')), norm(text));
});

test('REVIEW FOCUS: a 4000-character unbroken token (a pasted URL) cannot exceed the cap', () => {
  const text = 'x'.repeat(4000);
  const chunks = chunkText(text);
  for (const c of chunks) assert.ok(c.length <= 1500);
  assert.equal(chunks.join(''), text);
});

test('a custom cap is honoured', () => {
  for (const c of chunkText(sentences(60), 100)) assert.ok(c.length <= 100);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Documents/Code/research-audio && node --test tests/chunk.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/lib/chunk.mjs'`

- [ ] **Step 3: Write the implementation**

`scripts/lib/chunk.mjs`:
```js
function splitWords(sentence, max) {
  const out = [];
  let cur = '';
  for (let word of sentence.split(/\s+/)) {
    while (word.length > max) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (cur && cur.length + 1 + word.length > max) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

function splitLong(paragraph, max) {
  const out = [];
  let cur = '';
  const flush = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    const pieces = sentence.length > max ? splitWords(sentence, max) : [sentence];
    for (const piece of pieces) {
      if (cur && cur.length + 1 + piece.length > max) flush();
      cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  flush();
  return out;
}

export function chunkText(text, maxChars = 1500) {
  const units = [];
  for (const paragraph of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (paragraph.length <= maxChars) units.push(paragraph);
    else units.push(...splitLong(paragraph, maxChars));
  }
  const chunks = [];
  let cur = '';
  for (const unit of units) {
    if (cur && cur.length + 2 + unit.length > maxChars) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${unit}` : unit;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/Documents/Code/research-audio && node --test tests/chunk.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/Code/research-audio
git add scripts/lib/chunk.mjs tests/chunk.test.mjs
git commit -m "feat: split scripts into <=1500-char chunks at paragraph and sentence ends"
```

---

### Task 3: Script validator

**Files:**
- Create: `scripts/lib/validate-script.mjs`
- Test: `tests/validate-script.test.mjs`

**Interfaces:**
- Consumes: `sentences()` from `tests/helpers.mjs`
- Produces:
  - `TARGET_WORDS = { concise: 400, deep: 1200, deeper: 3000 }`, `TOLERANCE = 0.25`
  - `countWords(text): number`
  - `validateScript(text, depth): { ok: boolean, words: number, target: number, problems: string[] }` (throws `Error` on an unknown depth)

- [ ] **Step 1: Write the failing tests**

`tests/validate-script.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScript, countWords, TARGET_WORDS } from '../scripts/lib/validate-script.mjs';
import { sentences } from './helpers.mjs';

test('targets match the spec', () => {
  assert.deepEqual(TARGET_WORDS, { concise: 400, deep: 1200, deeper: 3000 });
});

test('countWords counts whitespace-separated words', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('one two\nthree'), 3);
});

test('a clean script near the target passes', () => {
  const r = validateScript(sentences(1200), 'deep');
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
});

test('the range is target +/- 25%', () => {
  assert.equal(validateScript(sentences(300), 'concise').ok, true);
  assert.equal(validateScript(sentences(500), 'concise').ok, true);
  assert.equal(validateScript(sentences(240), 'concise').ok, false);
  assert.equal(validateScript(sentences(600), 'concise').ok, false);
});

test('too short and too long are reported with the accepted range', () => {
  const short = validateScript(sentences(100), 'deep');
  assert.match(short.problems[0], /too short.*900-1500/);
  const long = validateScript(sentences(2400), 'deep');
  assert.match(long.problems[0], /too long/);
});

test('an empty script fails with a clear message', () => {
  const r = validateScript('   ', 'concise');
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /empty/);
});

for (const [label, snippet] of [
  ['heading', '# Heading\nbody'],
  ['bullet list', 'intro\n- first item\n- second'],
  ['numbered list', 'intro\n1. first\n2. second'],
  ['table row', 'a | b | c'],
  ['bold', 'this is **bold** text'],
  ['backtick', 'run `npm test` now'],
  ['markdown link', 'see [the docs](x) here'],
]) {
  test(`markdown is flagged: ${label}`, () => {
    const r = validateScript(`${sentences(400)}\n\n${snippet}`, 'concise');
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /markdown|list|heading|table|bold|backtick|link/i.test(p)), r.problems.join('|'));
  });
}

test('web addresses are flagged', () => {
  for (const url of ['https://example.com/a', 'visit www.example.com now']) {
    const r = validateScript(`${sentences(400)}\n\n${url}`, 'concise');
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /web address/.test(p)));
  }
});

test('natural spoken numbers and decimals are not flagged', () => {
  const text = `${sentences(400)}\n\nIt costs about two dollars seventy, or $2.70, and takes 7.5 minutes.`;
  assert.equal(validateScript(text, 'concise').ok, true);
});

test('an unknown depth throws', () => {
  assert.throws(() => validateScript('x', 'epic'), /Unknown depth/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Documents/Code/research-audio && node --test tests/validate-script.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/lib/validate-script.mjs'`

- [ ] **Step 3: Write the implementation**

`scripts/lib/validate-script.mjs`:
```js
export const TARGET_WORDS = { concise: 400, deep: 1200, deeper: 3000 };
export const TOLERANCE = 0.25;

const MARKDOWN = [
  [/^\s{0,3}#{1,6}\s/m, 'a markdown heading'],
  [/^\s*[-*•]\s+/m, 'a bullet list'],
  [/^\s*\d+[.)]\s+/m, 'a numbered list'],
  [/\|[^\n]*\|/, 'a table row'],
  [/\*\*|__/, 'bold markers'],
  [/`/, 'a backtick'],
  [/\]\(/, 'a markdown link'],
];
const URL_PATTERN = /https?:\/\/|www\./i;

export function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function validateScript(text, depth) {
  const target = TARGET_WORDS[depth];
  if (!target) throw new Error(`Unknown depth "${depth}"`);
  const words = countWords(text);
  const problems = [];
  if (words === 0) {
    problems.push('the script is empty');
  } else {
    const min = Math.round(target * (1 - TOLERANCE));
    const max = Math.round(target * (1 + TOLERANCE));
    if (words < min) problems.push(`too short: ${words} words, ${depth} needs ${min}-${max} (target ${target})`);
    else if (words > max) problems.push(`too long: ${words} words, ${depth} needs ${min}-${max} (target ${target})`);
  }
  for (const [pattern, label] of MARKDOWN) {
    if (pattern.test(text)) problems.push(`contains ${label}; write it as plain spoken prose`);
  }
  if (URL_PATTERN.test(text)) problems.push('contains a web address; name the source instead of reading a URL aloud');
  return { ok: problems.length === 0, words, target, problems };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/Documents/Code/research-audio && node --test tests/validate-script.test.mjs`
Expected: PASS, 16 tests

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/Code/research-audio
git add scripts/lib/validate-script.mjs tests/validate-script.test.mjs
git commit -m "feat: validate script length per depth and reject markdown/URLs"
```

---

### Task 4: OpenAI TTS client with retry

**Files:**
- Create: `scripts/lib/openai-tts.mjs`
- Test: `tests/openai-tts.test.mjs`

**Interfaces:**
- Consumes: `fakeResponse`, `scriptedFetch`, `noSleep` from `tests/helpers.mjs`
- Produces:
  - `TTS_URL = 'https://api.openai.com/v1/audio/speech'`, `DEFAULT_MODEL = 'gpt-4o-mini-tts'`, `TONE_INSTRUCTIONS` (the verbatim string from Global Constraints)
  - `class SynthesisError extends Error` with `.status` (number|undefined) and `.retryable` (boolean)
  - `synthesizeChunk(text, { apiKey, voice='marin', model=DEFAULT_MODEL, instructions=TONE_INSTRUCTIONS, fetchImpl=fetch, sleep, maxRetries=3 }): Promise<Buffer>`

- [ ] **Step 1: Write the failing tests**

`tests/openai-tts.test.mjs`:
```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Documents/Code/research-audio && node --test tests/openai-tts.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/lib/openai-tts.mjs'`

- [ ] **Step 3: Write the implementation**

`scripts/lib/openai-tts.mjs`:
```js
export const TTS_URL = 'https://api.openai.com/v1/audio/speech';
export const DEFAULT_MODEL = 'gpt-4o-mini-tts';
export const TONE_INSTRUCTIONS =
  'Speak as a calm, clear briefing narrator. Warm, steady pace, natural pauses between paragraphs, no theatrics.';

export class SynthesisError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function synthesizeChunk(text, {
  apiKey,
  voice = 'marin',
  model = DEFAULT_MODEL,
  instructions = TONE_INSTRUCTIONS,
  fetchImpl = fetch,
  sleep = defaultSleep,
  maxRetries = 3,
}) {
  const body = JSON.stringify({ model, voice, input: text, instructions, response_format: 'mp3' });
  const redact = (s) => (apiKey ? s.split(apiKey).join('[key]') : s);
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    let res;
    try {
      res = await fetchImpl(TTS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      lastError = new SynthesisError(`Network error talking to OpenAI: ${redact(err.message)}`, { retryable: true });
      continue;
    }
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 401 || res.status === 403) {
      throw new SynthesisError(`OpenAI rejected the API key (${res.status}). Check OPENAI_API_KEY.`, { status: res.status });
    }
    const detail = redact((await res.text()).slice(0, 200));
    const retryable = res.status === 429 || res.status >= 500;
    lastError = new SynthesisError(`OpenAI returned ${res.status}: ${detail}`, { status: res.status, retryable });
    if (!retryable) throw lastError;
  }
  throw lastError;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/Documents/Code/research-audio && node --test tests/openai-tts.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/Code/research-audio
git add scripts/lib/openai-tts.mjs tests/openai-tts.test.mjs
git commit -m "feat: OpenAI TTS client with retry and key redaction"
```

---

### Task 5: Audio helpers and synthesize

**Files:**
- Create: `scripts/lib/audio.mjs`, `scripts/synthesize.mjs`
- Test: `tests/synthesize.test.mjs`

**Interfaces:**
- Consumes: `chunkText`, `synthesizeChunk`/`SynthesisError`, `countWords`, test helpers `fakeResponse`, `scriptedFetch`, `noSleep`, `sentences`, `makeSineMp3`
- Produces:
  - `audio.mjs`: `hasFfmpeg(): boolean`; `encodeSpeech(inPath, outPath): void` (64 kbps mono; throws `Error` on failure)
  - `synthesize.mjs`:
    - `estimateCostUsd(seconds): number` (0.015 per minute, rounded to 3 decimals)
    - `synthesize({ text, outPath, apiKey, voice='marin', fetchImpl, sleep, concurrency=3, maxChars=1500, ffmpeg={has:hasFfmpeg, encode:encodeSpeech} }): Promise<{ outPath, bytes, seconds, costUsd, chunks, encoded, warnings: string[] }>`
    - The `ffmpeg` option exists so tests can simulate a machine without ffmpeg.

- [ ] **Step 1: Write the failing tests**

`tests/synthesize.test.mjs`:
```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Documents/Code/research-audio && node --test tests/synthesize.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/synthesize.mjs'`

- [ ] **Step 3: Write the implementation**

`scripts/lib/audio.mjs`:
```js
import { spawnSync } from 'node:child_process';

export function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

export function encodeSpeech(inPath, outPath) {
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', inPath, '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '64k', outPath],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').trim().slice(0, 300)}`);
}
```

`scripts/synthesize.mjs`:
```js
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/Documents/Code/research-audio && node --test tests/synthesize.test.mjs`
Expected: PASS, 8 tests (the real-ffmpeg test is skipped if ffmpeg is not installed)

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/Code/research-audio
git add scripts/lib/audio.mjs scripts/synthesize.mjs tests/synthesize.test.mjs
git commit -m "feat: chunked synthesis with ordered join, ffmpeg re-encode and fallbacks"
```

---

### Task 6: Delivery (email or file)

**Files:**
- Create: `scripts/deliver.mjs`
- Test: `tests/deliver.test.mjs`

**Interfaces:**
- Consumes: test helpers `fakeResponse`, `scriptedFetch`, `tmpHome`
- Produces:
  - `EMAIL_MAX_BYTES = 20 * 1024 * 1024`, `RESEND_URL = 'https://api.resend.com/emails'`
  - `emailSubject(topic, seconds): string` (single line; `Research audio (N min): <topic>`, N at least 1)
  - `emailText({ topic, depth, seconds, scriptText }): string`
  - `deliver({ mode, audioPath, scriptText, topic, depth, seconds, config, secrets, fetchImpl=fetch, attachmentName='research-audio.mp3' }): Promise<{ requested, mode: 'email'|'file', fellBack: boolean, reason?: string, path: string, emailId?: string }>` (never throws for delivery problems; it falls back to file)

- [ ] **Step 1: Write the failing tests**

`tests/deliver.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deliver, emailSubject, emailText, EMAIL_MAX_BYTES, RESEND_URL } from '../scripts/deliver.mjs';
import { fakeResponse, scriptedFetch, tmpHome } from './helpers.mjs';

const config = { recipient: 'me@example.com', from: 'Research <audio@example.com>' };
const secrets = { RESEND_API_KEY: 're_secret' };

function audioFile(contents = 'MP3BYTES') {
  const p = path.join(tmpHome(), 'audio.mp3');
  fs.writeFileSync(p, contents);
  return p;
}
const base = (over = {}) => ({
  mode: 'email', audioPath: audioFile(), scriptText: 'The spoken script.', topic: 'Voice engines',
  depth: 'deep', seconds: 480, config, secrets, ...over,
});

test('file mode just reports the saved path and never calls the network', async () => {
  const f = scriptedFetch(fakeResponse(200, {}));
  const r = await deliver(base({ mode: 'file', fetchImpl: f }));
  assert.equal(r.mode, 'file');
  assert.equal(r.fellBack, false);
  assert.equal(f.calls.length, 0);
});

test('email mode posts to Resend with the audio attached and the script in the body', async () => {
  const f = scriptedFetch(fakeResponse(200, { id: 'em_123' }));
  const opts = base({ fetchImpl: f, attachmentName: '2026-10-06-voice.mp3' });
  const r = await deliver(opts);
  assert.equal(r.mode, 'email');
  assert.equal(r.emailId, 'em_123');
  assert.equal(r.fellBack, false);
  const { url, init } = f.calls[0];
  assert.equal(url, RESEND_URL);
  assert.equal(init.headers.Authorization, 'Bearer re_secret');
  const body = JSON.parse(init.body);
  assert.deepEqual(body.to, ['me@example.com']);
  assert.equal(body.from, 'Research <audio@example.com>');
  assert.equal(body.subject, 'Research audio (8 min): Voice engines');
  assert.match(body.text, /The spoken script\./);
  assert.equal(body.attachments[0].filename, '2026-10-06-voice.mp3');
  assert.equal(body.attachments[0].content, Buffer.from('MP3BYTES').toString('base64'));
});

test('a Resend error falls back to file mode and says why', async () => {
  const f = scriptedFetch(fakeResponse(403, '{"message":"domain not verified"}'));
  const r = await deliver(base({ fetchImpl: f }));
  assert.equal(r.mode, 'file');
  assert.equal(r.fellBack, true);
  assert.match(r.reason, /403.*domain not verified/);
});

test('a network failure also falls back', async () => {
  const f = scriptedFetch(new TypeError('fetch failed'));
  const r = await deliver(base({ fetchImpl: f }));
  assert.equal(r.fellBack, true);
  assert.match(r.reason, /could not reach Resend/);
});

test('an unreadable success body does not trigger a fallback (the email was sent)', async () => {
  const f = scriptedFetch(fakeResponse(200, 'not json'));
  const r = await deliver(base({ fetchImpl: f }));
  assert.equal(r.mode, 'email');
  assert.equal(r.fellBack, false);
});

test('audio over 20 MB falls back to file without calling Resend', async () => {
  const p = path.join(tmpHome(), 'big.mp3');
  fs.writeFileSync(p, '');
  fs.truncateSync(p, EMAIL_MAX_BYTES + 1);
  const f = scriptedFetch(fakeResponse(200, { id: 'x' }));
  const r = await deliver(base({ audioPath: p, fetchImpl: f }));
  assert.equal(r.mode, 'file');
  assert.equal(r.fellBack, true);
  assert.match(r.reason, /20 MB/);
  assert.equal(f.calls.length, 0);
});

test('the error reason never contains the Resend key', async () => {
  const f = scriptedFetch(fakeResponse(401, 'invalid key re_secret'));
  const r = await deliver(base({ fetchImpl: f }));
  assert.ok(!r.reason.includes('re_secret'));
});

test('REVIEW FOCUS: a newline in the topic cannot inject an email header via the subject', () => {
  const subject = emailSubject('Hello\r\nBcc: evil@example.com', 300);
  assert.ok(!/[\r\n]/.test(subject));
  assert.equal(subject, 'Research audio (5 min): Hello Bcc: evil@example.com');
});

test('subject minutes are at least 1 and a blank topic becomes "research"', () => {
  assert.equal(emailSubject('x', 10), 'Research audio (1 min): x');
  assert.equal(emailSubject('   ', 120), 'Research audio (2 min): research');
});

test('emailText lists topic, depth, length and the script', () => {
  const t = emailText({ topic: 'T', depth: 'deeper', seconds: 1200, scriptText: 'Body here.' });
  assert.match(t, /Topic: T/);
  assert.match(t, /Depth: deeper/);
  assert.match(t, /20 min/);
  assert.match(t, /Body here\./);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Documents/Code/research-audio && node --test tests/deliver.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/deliver.mjs'`

- [ ] **Step 3: Write the implementation**

`scripts/deliver.mjs`:
```js
import fs from 'node:fs';

export const EMAIL_MAX_BYTES = 20 * 1024 * 1024;
export const RESEND_URL = 'https://api.resend.com/emails';

const minutesOf = (seconds) => Math.max(1, Math.round(seconds / 60));

export function emailSubject(topic, seconds) {
  const clean = String(topic).replace(/\s+/g, ' ').trim() || 'research';
  return `Research audio (${minutesOf(seconds)} min): ${clean}`;
}

export function emailText({ topic, depth, seconds, scriptText }) {
  return [
    `Topic: ${topic}`,
    `Depth: ${depth}, about ${minutesOf(seconds)} min`,
    '',
    'The audio is attached. The full script follows, for reference.',
    '',
    '----',
    '',
    scriptText,
    '',
  ].join('\n');
}

export async function deliver({
  mode,
  audioPath,
  scriptText,
  topic,
  depth,
  seconds,
  config,
  secrets,
  fetchImpl = fetch,
  attachmentName = 'research-audio.mp3',
}) {
  const base = { requested: mode, path: audioPath };
  if (mode !== 'email') return { ...base, mode: 'file', fellBack: false };

  const fallback = (reason) => ({ ...base, mode: 'file', fellBack: true, reason });
  const bytes = fs.statSync(audioPath).size;
  if (bytes > EMAIL_MAX_BYTES) {
    return fallback(`the audio is ${(bytes / 1048576).toFixed(1)} MB, over the 20 MB email limit`);
  }

  const key = secrets.RESEND_API_KEY;
  const redact = (s) => (key ? s.split(key).join('[key]') : s);
  let res;
  try {
    res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.from,
        to: [config.recipient],
        subject: emailSubject(topic, seconds),
        text: emailText({ topic, depth, seconds, scriptText }),
        attachments: [{ filename: attachmentName, content: fs.readFileSync(audioPath).toString('base64') }],
      }),
    });
  } catch (err) {
    return fallback(`could not reach Resend: ${redact(err.message)}`);
  }
  if (!res.ok) {
    const detail = redact((await res.text()).slice(0, 200));
    return fallback(`Resend returned ${res.status}: ${detail}`);
  }
  let emailId;
  try {
    emailId = (await res.json()).id;
  } catch {
    emailId = undefined;
  }
  return { ...base, mode: 'email', fellBack: false, emailId };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/Documents/Code/research-audio && node --test tests/deliver.test.mjs`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/Code/research-audio
git add scripts/deliver.mjs tests/deliver.test.mjs
git commit -m "feat: deliver by Resend email or file, with fallbacks and header-safe subject"
```

---

### Task 7: send.mjs and setup.mjs CLIs

**Files:**
- Create: `scripts/send.mjs`, `scripts/setup.mjs`
- Test: `tests/send.test.mjs`, `tests/setup.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-6; test helpers `setupHome`, `scriptedFetch`, `fakeResponse`, `sentences`, `tmpHome`
- Produces (`send.mjs`):
  - `slugify(topic): string` (lowercase ASCII `a-z0-9-`, at most 48 chars, `'research'` when nothing is left)
  - `makeRunDir(outputDir, topic, date=new Date()): string` (creates `<outputDir>/<YYYY-MM-DD>-<slug>`, adds `-2`, `-3` on collision)
  - `parseArgs(argv): { init, check, noValidate, script, topic, depth, deliver }` (throws `Error` on unknown flags)
  - `runSend({ argv, env=process.env, fetchImpl=fetch, sleep, ffmpeg }): Promise<{ exitCode, result }>`
  - Modes: `--init --topic T [--depth --deliver]` -> `{ok, stage:'init', runDir, scriptPath, depth, targetWords, deliver}`; `--check --script P [--depth]` -> `{ok, stage:'check', words, depth}` or exit 2 with `{ok:false, stage:'validate', problems, ...}`; default send -> `{ok:true, requested, mode, fellBack, reason?, runDir, scriptPath, audioPath, minutes, seconds, bytes, costUsd, emailId?, warnings}`
  - Failure shapes: `{ok:false, stage:'config'|'usage'|'voice'|'validate', error|problems, ...}`; a `voice` failure includes `scriptPath` and `hint`.
  - When run directly (`node send.mjs ...`) it prints the result JSON and sets `process.exitCode`.
- Produces (`setup.mjs`):
  - `runSetup({ argv, env=process.env, fetchImpl=fetch, sleep, ffmpeg }): Promise<{ exitCode, result }>`
  - Flags: `--depth --deliver --recipient --from --output-dir --voice --test-clip --test-email`
  - Result: `{ok:true, configPath, envPath, config, missing: string[], testClip?, testEmail?}` or `{ok:false, problems|error}`
  - When run directly it prints the result JSON and sets `process.exitCode`.

- [ ] **Step 1: Write the failing send tests**

`tests/send.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSend, slugify, makeRunDir, parseArgs } from '../scripts/send.mjs';
import { setupHome, scriptedFetch, fakeResponse, sentences, tmpHome } from './helpers.mjs';

const NO_FFMPEG = { has: () => false, encode: () => {} };
const router = () =>
  scriptedFetch((url) => (url.includes('openai') ? fakeResponse(200, 'AUDIO') : fakeResponse(200, { id: 'em_1' })));
const openaiCalls = (f) => f.calls.filter((c) => c.url.includes('openai'));
const resendCalls = (f) => f.calls.filter((c) => c.url.includes('resend'));

function writeScript(runDir, text) {
  const p = path.join(runDir, 'script.txt');
  fs.writeFileSync(p, text);
  return p;
}

test('slugify keeps a-z0-9, trims, caps length and never returns empty', () => {
  assert.equal(slugify('Voice Engines: OpenAI vs Gemini!'), 'voice-engines-openai-vs-gemini');
  assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu');
  assert.ok(slugify('a'.repeat(200)).length <= 48);
});

test('REVIEW FOCUS: emoji-only, Hebrew-only, slash and dot topics give a safe non-empty slug', () => {
  for (const t of ['🔥🔥', 'מחקר שוק', '../../etc/passwd', '...', '']) {
    const s = slugify(t);
    assert.match(s, /^[a-z0-9-]+$/, `slug for "${t}" was "${s}"`);
    assert.ok(!s.includes('..'));
  }
  assert.equal(slugify('🔥'), 'research');
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
});

test('REVIEW FOCUS: the same topic twice on one day gets a new folder, never overwrites', () => {
  const out = tmpHome();
  const d = new Date(2026, 9, 6);
  const a = makeRunDir(out, 'Voice engines', d);
  fs.writeFileSync(path.join(a, 'audio.mp3'), 'first');
  const b = makeRunDir(out, 'Voice engines', d);
  assert.equal(path.basename(a), '2026-10-06-voice-engines');
  assert.equal(path.basename(b), '2026-10-06-voice-engines-2');
  assert.equal(fs.readFileSync(path.join(a, 'audio.mp3'), 'utf8'), 'first');
});

test('parseArgs reads values and booleans and rejects unknown flags', () => {
  assert.deepEqual(
    parseArgs(['--script', 'a.txt', '--topic', 'T', '--depth', 'deep', '--deliver', 'file', '--no-validate']),
    { init: false, check: false, noValidate: true, script: 'a.txt', topic: 'T', depth: 'deep', deliver: 'file' },
  );
  assert.throws(() => parseArgs(['--wat']), /Unknown flag/);
  assert.throws(() => parseArgs(['--topic']), /needs a value/);
});

test('--init creates the run folder and reports the script path and word target', async () => {
  const { env, outputDir } = setupHome({ depth: 'concise' });
  const { exitCode, result } = await runSend({ argv: ['--init', '--topic', 'Voice engines'], env });
  assert.equal(exitCode, 0);
  assert.equal(result.stage, 'init');
  assert.equal(result.targetWords, 400);
  assert.equal(result.deliver, 'file');
  assert.ok(result.runDir.startsWith(outputDir));
  assert.equal(result.scriptPath, path.join(result.runDir, 'script.txt'));
  assert.ok(fs.existsSync(result.runDir));
});

test('--init honours --depth and --deliver overrides', async () => {
  const { env } = setupHome({ depth: 'concise', deliver: 'email' });
  const { result } = await runSend({ argv: ['--init', '--topic', 'T', '--depth', 'deeper', '--deliver', 'file'], env });
  assert.equal(result.targetWords, 3000);
  assert.equal(result.deliver, 'file');
});

test('REVIEW FOCUS: email mode without a Resend key fails at --init, before any folder or spend', async () => {
  const { env, outputDir } = setupHome({ deliver: 'email', resend: '' });
  const f = router();
  const { exitCode, result } = await runSend({ argv: ['--init', '--topic', 'T'], env, fetchImpl: f });
  assert.equal(exitCode, 1);
  assert.equal(result.stage, 'config');
  assert.match(result.error, /RESEND_API_KEY/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(outputDir), false);
});

test('not set up: every mode reports a config error pointing at setup', async () => {
  const env = { RESEARCH_AUDIO_HOME: tmpHome() };
  const { exitCode, result } = await runSend({ argv: ['--init', '--topic', 'T'], env });
  assert.equal(exitCode, 1);
  assert.match(result.error, /setup/);
});

test('--check passes a good script and exits 2 with problems for a bad one', async () => {
  const { env, outputDir } = setupHome({ depth: 'concise' });
  const dir = makeRunDir(outputDir, 'T');
  const good = writeScript(dir, sentences(400));
  assert.equal((await runSend({ argv: ['--check', '--script', good], env })).exitCode, 0);
  const bad = writeScript(dir, `${sentences(400)}\n\nSee https://example.com`);
  const r = await runSend({ argv: ['--check', '--script', bad], env });
  assert.equal(r.exitCode, 2);
  assert.equal(r.result.stage, 'validate');
  assert.ok(r.result.problems.some((p) => /web address/.test(p)));
});

test('an empty script fails validation and spends nothing', async () => {
  const { env, outputDir } = setupHome({ depth: 'concise' });
  const f = router();
  const p = writeScript(makeRunDir(outputDir, 'T'), '');
  const { exitCode, result } = await runSend({ argv: ['--script', p], env, fetchImpl: f, ffmpeg: NO_FFMPEG });
  assert.equal(exitCode, 2);
  assert.match(result.problems[0], /empty/);
  assert.equal(f.calls.length, 0);
});

test('--depth changes the accepted length: 400 words pass concise but fail deeper', async () => {
  const { env, outputDir } = setupHome({ depth: 'concise' });
  const p = writeScript(makeRunDir(outputDir, 'T'), sentences(400));
  assert.equal((await runSend({ argv: ['--check', '--script', p], env })).exitCode, 0);
  assert.equal((await runSend({ argv: ['--check', '--script', p, '--depth', 'deeper'], env })).exitCode, 2);
});

test('--no-validate sends a script that would fail the length check', async () => {
  const { env, outputDir } = setupHome({ depth: 'deeper' });
  const f = router();
  const p = writeScript(makeRunDir(outputDir, 'T'), sentences(100));
  const { exitCode } = await runSend({ argv: ['--script', p, '--no-validate'], env, fetchImpl: f, ffmpeg: NO_FFMPEG });
  assert.equal(exitCode, 0);
});

test('file mode: synthesizes into the run folder and reports duration and cost', async () => {
  const { env, outputDir } = setupHome({ depth: 'concise' });
  const f = router();
  const runDir = makeRunDir(outputDir, 'Voice engines');
  const p = writeScript(runDir, sentences(400));
  const { exitCode, result } = await runSend({ argv: ['--script', p, '--topic', 'Voice engines'], env, fetchImpl: f, ffmpeg: NO_FFMPEG });
  assert.equal(exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'file');
  assert.equal(result.fellBack, false);
  assert.equal(result.audioPath, path.join(runDir, 'audio.mp3'));
  assert.ok(fs.existsSync(result.audioPath));
  assert.equal(result.minutes, 3);
  assert.ok(result.costUsd > 0);
  assert.ok(openaiCalls(f).length > 0);
  assert.equal(resendCalls(f).length, 0);
});

test('email mode: voice then Resend, attachment named after the run folder', async () => {
  const { env, outputDir } = setupHome({ depth: 'concise', deliver: 'email' });
  const f = router();
  const runDir = makeRunDir(outputDir, 'Voice engines');
  const p = writeScript(runDir, sentences(400));
  const { result } = await runSend({ argv: ['--script', p, '--topic', 'Voice engines'], env, fetchImpl: f, ffmpeg: NO_FFMPEG });
  assert.equal(result.mode, 'email');
  assert.equal(result.emailId, 'em_1');
  const body = JSON.parse(resendCalls(f)[0].init.body);
  assert.equal(body.attachments[0].filename, `${path.basename(runDir)}.mp3`);
});

test('a Resend failure still leaves the audio file and reports the fallback', async () => {
  const { env, outputDir } = setupHome({ depth: 'concise', deliver: 'email' });
  const f = scriptedFetch((url) => (url.includes('openai') ? fakeResponse(200, 'AUDIO') : fakeResponse(403, 'domain not verified')));
  const p = writeScript(makeRunDir(outputDir, 'T'), sentences(400));
  const { exitCode, result } = await runSend({ argv: ['--script', p], env, fetchImpl: f, ffmpeg: NO_FFMPEG });
  assert.equal(exitCode, 0);
  assert.equal(result.mode, 'file');
  assert.equal(result.fellBack, true);
  assert.match(result.reason, /403/);
  assert.ok(fs.existsSync(result.audioPath));
});

test('an OpenAI 401 keeps the script, names the stage, and never leaks the key', async () => {
  const { env, outputDir } = setupHome({ depth: 'concise', openai: 'sk-live-SECRET123' });
  const f = scriptedFetch(fakeResponse(401, 'Incorrect API key provided: sk-live-SECRET123'));
  const p = writeScript(makeRunDir(outputDir, 'T'), sentences(400));
  const { exitCode, result } = await runSend({ argv: ['--script', p], env, fetchImpl: f, ffmpeg: NO_FFMPEG });
  assert.equal(exitCode, 1);
  assert.equal(result.stage, 'voice');
  assert.equal(result.scriptPath, p);
  assert.match(result.hint, /--no-validate/);
  assert.ok(fs.existsSync(p));
  assert.ok(!JSON.stringify(result).includes('SECRET123'));
});

test('a missing script file is a usage error', async () => {
  const { env } = setupHome();
  const { exitCode, result } = await runSend({ argv: ['--script', '/nope/script.txt'], env });
  assert.equal(exitCode, 1);
  assert.equal(result.stage, 'usage');
});

test('the CLI still prints its JSON when launched through a symlink (plugin caches can be symlinked)', () => {
  const real = fileURLToPath(new URL('../scripts/send.mjs', import.meta.url));
  const link = path.join(tmpHome(), 'send-link.mjs');
  fs.symlinkSync(real, link);
  const r = spawnSync(process.execPath, [link, '--init', '--topic', 'T'], {
    encoding: 'utf8',
    env: { ...process.env, RESEARCH_AUDIO_HOME: tmpHome() },
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'config');
  assert.equal(r.status, 1);
});
```

- [ ] **Step 2: Write the failing setup tests**

`tests/setup.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSetup } from '../scripts/setup.mjs';
import { loadConfig, parseEnvFile } from '../scripts/lib/config.mjs';
import { tmpHome, scriptedFetch, fakeResponse } from './helpers.mjs';

const NO_FFMPEG = { has: () => false, encode: () => {} };
const homeEnv = (extra = {}) => ({ RESEARCH_AUDIO_HOME: tmpHome(), ...extra });

test('writes config.json and an env template with mode 0600', async () => {
  const env = homeEnv();
  const { exitCode, result } = await runSetup({ argv: ['--depth', 'concise', '--deliver', 'file'], env });
  assert.equal(exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(loadConfig(env).depth, 'concise');
  assert.equal(loadConfig(env).deliver, 'file');
  const envFile = path.join(env.RESEARCH_AUDIO_HOME, 'env');
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  const text = fs.readFileSync(envFile, 'utf8');
  assert.match(text, /^OPENAI_API_KEY=$/m);
  assert.doesNotMatch(text, /RESEND_API_KEY/);
  assert.deepEqual(result.missing, ['OPENAI_API_KEY']);
});

test('email mode adds the Resend line and requires recipient and from', async () => {
  const bad = await runSetup({ argv: ['--depth', 'deep', '--deliver', 'email'], env: homeEnv() });
  assert.equal(bad.exitCode, 1);
  assert.ok(bad.result.problems.some((p) => /recipient/.test(p)));

  const env = homeEnv();
  const { result } = await runSetup({ argv: ['--depth', 'deep', '--deliver', 'email', '--recipient', 'me@x.co', '--from', 'Me <a@x.co>'], env });
  assert.equal(result.ok, true);
  assert.match(fs.readFileSync(path.join(env.RESEARCH_AUDIO_HOME, 'env'), 'utf8'), /^RESEND_API_KEY=$/m);
  assert.deepEqual(result.missing.sort(), ['OPENAI_API_KEY', 'RESEND_API_KEY']);
});

test('an OPENAI_API_KEY already in the shell is reused: no template line, nothing missing', async () => {
  const env = homeEnv({ OPENAI_API_KEY: 'sk-from-shell' });
  const { result } = await runSetup({ argv: ['--depth', 'deep', '--deliver', 'file'], env });
  assert.deepEqual(result.missing, []);
  assert.doesNotMatch(fs.readFileSync(path.join(env.RESEARCH_AUDIO_HOME, 'env'), 'utf8'), /OPENAI_API_KEY/);
});

test('re-running keeps existing secrets, adds only missing lines, and merges settings', async () => {
  const env = homeEnv();
  await runSetup({ argv: ['--depth', 'concise', '--deliver', 'file'], env });
  const envFile = path.join(env.RESEARCH_AUDIO_HOME, 'env');
  fs.writeFileSync(envFile, 'OPENAI_API_KEY=sk-keep-me\n');
  const { result } = await runSetup({ argv: ['--deliver', 'email', '--recipient', 'me@x.co', '--from', 'a@x.co'], env });
  const parsed = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
  assert.equal(parsed.OPENAI_API_KEY, 'sk-keep-me');
  assert.ok('RESEND_API_KEY' in parsed);
  assert.equal(loadConfig(env).depth, 'concise');
  assert.equal(loadConfig(env).deliver, 'email');
  assert.deepEqual(result.missing, ['RESEND_API_KEY']);
});

test('an invalid depth is rejected and nothing is written', async () => {
  const env = homeEnv();
  const { exitCode, result } = await runSetup({ argv: ['--depth', 'epic'], env });
  assert.equal(exitCode, 1);
  assert.ok(result.problems.some((p) => /depth/.test(p)));
  assert.equal(fs.existsSync(path.join(env.RESEARCH_AUDIO_HOME, 'config.json')), false);
});

test('--test-clip makes one short clip with the saved voice', async () => {
  const env = homeEnv({ OPENAI_API_KEY: 'sk-test' });
  const f = scriptedFetch(fakeResponse(200, 'AUDIO'));
  const { result } = await runSetup({ argv: ['--depth', 'deep', '--deliver', 'file', '--test-clip'], env, fetchImpl: f, ffmpeg: NO_FFMPEG });
  assert.equal(result.testClip.ok, true);
  assert.ok(fs.existsSync(result.testClip.path));
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0].init.body).voice, 'marin');
});

test('--test-clip without a key explains what to do and makes no request', async () => {
  const env = homeEnv();
  const f = scriptedFetch(fakeResponse(200, 'AUDIO'));
  const { result } = await runSetup({ argv: ['--depth', 'deep', '--deliver', 'file', '--test-clip'], env, fetchImpl: f });
  assert.equal(result.testClip.ok, false);
  assert.match(result.testClip.error, /OPENAI_API_KEY/);
  assert.equal(f.calls.length, 0);
});

test('--test-email sends the clip to the configured recipient through Resend', async () => {
  const env = homeEnv({ OPENAI_API_KEY: 'sk-test', RESEND_API_KEY: 're_test' });
  const f = scriptedFetch((url) => (url.includes('openai') ? fakeResponse(200, 'AUDIO') : fakeResponse(200, { id: 'em_9' })));
  const { result } = await runSetup({
    argv: ['--depth', 'deep', '--deliver', 'email', '--recipient', 'me@x.co', '--from', 'a@x.co', '--test-email'],
    env, fetchImpl: f, ffmpeg: NO_FFMPEG,
  });
  assert.equal(result.testEmail.mode, 'email');
  assert.equal(result.testEmail.emailId, 'em_9');
});

test('the CLI still prints its JSON when launched through a symlink', () => {
  const real = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url));
  const link = path.join(tmpHome(), 'setup-link.mjs');
  fs.symlinkSync(real, link);
  const r = spawnSync(process.execPath, [link, '--depth', 'epic'], {
    encoding: 'utf8',
    env: { ...process.env, RESEARCH_AUDIO_HOME: tmpHome() },
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(r.status, 1);
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd ~/Documents/Code/research-audio && node --test tests/send.test.mjs tests/setup.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/send.mjs'`

- [ ] **Step 4: Write `scripts/send.mjs`**

```js
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig, applyOverrides, loadSecrets, requireSecrets } from './lib/config.mjs';
import { validateScript, TARGET_WORDS } from './lib/validate-script.mjs';
import { synthesize } from './synthesize.mjs';
import { deliver } from './deliver.mjs';

export function slugify(topic) {
  const slug = String(topic)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'research';
}

export function makeRunDir(outputDir, topic, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const base = `${day}-${slugify(topic)}`;
  let candidate = base;
  for (let n = 2; fs.existsSync(path.join(outputDir, candidate)); n++) candidate = `${base}-${n}`;
  const dir = path.join(outputDir, candidate);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const VALUE_FLAGS = { '--script': 'script', '--topic': 'topic', '--depth': 'depth', '--deliver': 'deliver' };
const BOOL_FLAGS = { '--init': 'init', '--check': 'check', '--no-validate': 'noValidate' };

export function parseArgs(argv) {
  const args = { init: false, check: false, noValidate: false, script: undefined, topic: undefined, depth: undefined, deliver: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag in BOOL_FLAGS) args[BOOL_FLAGS[flag]] = true;
    else if (flag in VALUE_FLAGS) {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      args[VALUE_FLAGS[flag]] = argv[++i];
    } else throw new Error(`Unknown flag ${flag}`);
  }
  return args;
}

const fail = (stage, error) => ({ exitCode: 1, result: { ok: false, stage, error } });

export async function runSend({ argv, env = process.env, fetchImpl = fetch, sleep, ffmpeg } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return fail('usage', err.message);
  }

  try {
    const cfg = applyOverrides(loadConfig(env), { depth: args.depth, deliver: args.deliver });

    if (args.init) {
      requireSecrets(cfg, loadSecrets(env), env);
      const topic = args.topic || 'research';
      const runDir = makeRunDir(cfg.outputDir, topic);
      return {
        exitCode: 0,
        result: {
          ok: true, stage: 'init', runDir, scriptPath: path.join(runDir, 'script.txt'),
          depth: cfg.depth, targetWords: TARGET_WORDS[cfg.depth], deliver: cfg.deliver,
        },
      };
    }

    if (!args.script) return fail('usage', '--script <path> is required');
    const scriptPath = path.resolve(args.script);
    if (!fs.existsSync(scriptPath)) return fail('usage', `script not found: ${scriptPath}`);
    const scriptText = fs.readFileSync(scriptPath, 'utf8');

    if (args.check || !args.noValidate) {
      const v = validateScript(scriptText, cfg.depth);
      if (!v.ok) {
        return { exitCode: 2, result: { ok: false, stage: 'validate', depth: cfg.depth, words: v.words, problems: v.problems, scriptPath } };
      }
      if (args.check) return { exitCode: 0, result: { ok: true, stage: 'check', depth: cfg.depth, words: v.words } };
    }

    const secrets = loadSecrets(env);
    requireSecrets(cfg, secrets, env);

    const runDir = path.dirname(scriptPath);
    const audioPath = path.join(runDir, 'audio.mp3');
    const topic = args.topic || path.basename(runDir);

    let audio;
    try {
      audio = await synthesize({
        text: scriptText, outPath: audioPath, apiKey: secrets.OPENAI_API_KEY,
        voice: cfg.voice, fetchImpl, sleep, ...(ffmpeg && { ffmpeg }),
      });
    } catch (err) {
      return {
        exitCode: 1,
        result: {
          ok: false, stage: 'voice', error: err.message, scriptPath,
          hint: `The script was kept. Retry with: --script "${scriptPath}" --no-validate`,
        },
      };
    }

    const delivery = await deliver({
      mode: cfg.deliver, audioPath, scriptText, topic, depth: cfg.depth, seconds: audio.seconds,
      config: cfg, secrets, fetchImpl, attachmentName: `${path.basename(runDir)}.mp3`,
    });

    return {
      exitCode: 0,
      result: {
        ok: true,
        requested: delivery.requested, mode: delivery.mode, fellBack: delivery.fellBack,
        ...(delivery.reason && { reason: delivery.reason }),
        ...(delivery.emailId && { emailId: delivery.emailId }),
        runDir, scriptPath, audioPath,
        minutes: Math.max(1, Math.round(audio.seconds / 60)),
        seconds: audio.seconds, bytes: audio.bytes, costUsd: audio.costUsd, warnings: audio.warnings,
      },
    };
  } catch (err) {
    if (err instanceof ConfigError) return fail('config', err.message);
    throw err;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  const { exitCode, result } = await runSend({ argv: process.argv.slice(2) });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = exitCode;
}
```

- [ ] **Step 5: Write `scripts/setup.mjs`**

```js
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULTS, ConfigError, configDir, validateConfig, loadConfig, saveConfig,
  loadSecrets, requiredSecrets, parseEnvFile,
} from './lib/config.mjs';
import { synthesize } from './synthesize.mjs';
import { deliver } from './deliver.mjs';

const VALUE_FLAGS = {
  '--depth': 'depth', '--deliver': 'deliver', '--recipient': 'recipient',
  '--from': 'from', '--output-dir': 'outputDir', '--voice': 'voice',
};
const BOOL_FLAGS = { '--test-clip': 'testClip', '--test-email': 'testEmail' };

function parseSetupArgs(argv) {
  const settings = {};
  const flags = { testClip: false, testEmail: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag in BOOL_FLAGS) flags[BOOL_FLAGS[flag]] = true;
    else if (flag in VALUE_FLAGS) {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      settings[VALUE_FLAGS[flag]] = argv[++i];
    } else throw new Error(`Unknown flag ${flag}`);
  }
  return { settings, flags };
}

function readSavedConfig(env) {
  const file = path.join(configDir(env), 'config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeEnvTemplate(cfg, env) {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'env');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const present = parseEnvFile(existing);
  const toAdd = requiredSecrets(cfg).filter((k) => !(k in present) && !(env[k] || '').trim());
  let text = existing;
  if (!text) text = '# research-audio secrets. Fill in the values after the = sign and keep this file private.\n';
  else if (!text.endsWith('\n') && toAdd.length) text += '\n';
  for (const key of toAdd) text += `${key}=\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export async function runSetup({ argv, env = process.env, fetchImpl = fetch, sleep, ffmpeg } = {}) {
  let parsed;
  try {
    parsed = parseSetupArgs(argv);
  } catch (err) {
    return { exitCode: 1, result: { ok: false, error: err.message } };
  }

  const cfg = { ...DEFAULTS, ...readSavedConfig(env), ...parsed.settings };
  const problems = validateConfig(cfg);
  if (problems.length) return { exitCode: 1, result: { ok: false, problems } };

  const configPath = saveConfig(cfg, env);
  const envPath = writeEnvTemplate(cfg, env);
  const secrets = loadSecrets(env);
  const missing = requiredSecrets(cfg).filter((k) => !secrets[k]);
  const result = { ok: true, configPath, envPath, config: cfg, missing };

  if (parsed.flags.testClip || parsed.flags.testEmail) {
    if (!secrets.OPENAI_API_KEY) {
      result.testClip = { ok: false, error: `OPENAI_API_KEY is missing. Add it to ${envPath}, then re-run with --test-clip.` };
    } else {
      const clipPath = path.join(configDir(env), 'test-clip.mp3');
      try {
        const audio = await synthesize({
          text: 'This is a test of your research audio setup. If you can hear this, the voice works.',
          outPath: clipPath, apiKey: secrets.OPENAI_API_KEY, voice: loadConfig(env).voice,
          fetchImpl, sleep, ...(ffmpeg && { ffmpeg }),
        });
        result.testClip = { ok: true, path: clipPath, seconds: audio.seconds, costUsd: audio.costUsd };
        if (parsed.flags.testEmail) {
          if (cfg.deliver !== 'email') result.testEmail = { ok: false, error: 'delivery is set to file; choose email to test it' };
          else if (!secrets.RESEND_API_KEY) result.testEmail = { ok: false, error: `RESEND_API_KEY is missing. Add it to ${envPath}.` };
          else {
            result.testEmail = await deliver({
              mode: 'email', audioPath: clipPath, scriptText: 'This was a test clip from research-audio setup.',
              topic: 'setup test', depth: cfg.depth, seconds: audio.seconds, config: cfg, secrets, fetchImpl,
              attachmentName: 'test-clip.mp3',
            });
          }
        }
      } catch (err) {
        result.testClip = { ok: false, error: err.message };
      }
    }
  }
  return { exitCode: 0, result };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  try {
    const { exitCode, result } = await runSetup({ argv: process.argv.slice(2) });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = exitCode;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err instanceof ConfigError ? err.message : String(err.message || err) }, null, 2));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 6: Run both to verify they pass**

Run: `cd ~/Documents/Code/research-audio && node --test tests/send.test.mjs tests/setup.test.mjs`
Expected: PASS (18 send tests, 9 setup tests)

- [ ] **Step 7: Run the whole suite**

Run: `cd ~/Documents/Code/research-audio && npm test`
Expected: PASS, every test file green, 0 failures

- [ ] **Step 8: Commit**

```bash
cd ~/Documents/Code/research-audio
git add scripts/send.mjs scripts/setup.mjs tests/send.test.mjs tests/setup.test.mjs
git commit -m "feat: send and setup CLIs with init/check/send modes and fail-fast key check"
```

---

### Task 8: Skill, commands, README, live smoke test and end-to-end check

**Files:**
- Create: `skills/research-audio/SKILL.md`, `commands/setup.md`, `commands/send.md`, `README.md`
- Create: `tests/live/smoke.mjs`

**Interfaces:**
- Consumes: the CLI contracts from Task 7 (`setup.mjs` flags and JSON; `send.mjs --init | --check | send` and JSON)
- Produces: the installed plugin surface: `/research-audio:setup`, `/research-audio:send`, and the `research-audio` skill

- [ ] **Step 1: Write the skill**

`skills/research-audio/SKILL.md`:
```markdown
---
name: research-audio
description: Use when writing the spoken script for a research-audio summary. Turns what a session found into plain spoken prose at the user's saved depth (concise, deep or deeper), written for the ear and not for the eye.
---

# Writing a research script for the ear

The listener is walking with earbuds in and no screen. Write what a good briefer would say out loud. The script is validated before any audio is made, so follow the rules below.

## Gather first

Before writing, list everything this session actually established: the question, the verdict or recommendation, each finding with its numbers, what was ruled out and why, anything uncertain or unverified, and the next step. Use only these. Do not add facts that are not in the session.

## Depth

The user chose one depth at setup (the send command tells you which and gives the word target). Stay within about 25% of the target.

- **concise** (about 400 words, 2-3 minutes): the verdict in one sentence, the three findings that matter most, the next step.
- **deep** (about 1,200 words, 7-8 minutes): everything in concise, plus the reasoning behind the verdict, the key numbers, the caveats, and what was ruled out and why.
- **deeper** (about 3,000 words, 15-20 minutes): every finding in order, with its evidence; sources by name; what was ruled out; every open question and uncertainty; the next steps.

Each depth contains the one below it. Never pad. If the session found less than the target, say less and stay as close to the target as the content honestly allows.

## Shape

1. Open with one line naming the topic, for example "Here is your research summary: which voice engine should the audio plugin use."
2. Give the verdict straight away, in one or two sentences.
3. Signpost the structure: "Three things stand out." Then walk through them with plain connectors: first, second, third, one caution.
4. Close with the next step, or the decision the listener has to make.

## Spoken-language rules

- Plain prose only. No headings, bullets, numbered lists, tables, bold, backticks or links. The validator rejects them.
- Never read a web address aloud. Name the source instead: "the Artificial Analysis listening arena".
- Say numbers the way people say them: "about two dollars seventy", "roughly forty percent", "October sixth". Write units out: "twenty minutes", "ten megabytes".
- Acronyms read letter by letter get spaced letters ("A P I", "T T S"). Acronyms said as words stay as words ("NASA").
- Keep sentences short enough to say in one breath. Prefer active voice. No "as you can see", no "see below", no file paths, no code.
- Separate paragraphs with a blank line, and keep each under about 900 characters. A blank line becomes a pause, and long paragraphs are split at sentence ends.

## Honesty

Say what is unverified, in the same breath as the claim: "I could not confirm this", "this comes from a blog summary, not the source". Do not turn uncertain findings into firm ones to sound smoother.

## Before you save

Count roughly: about 150 words is a minute of speech. Re-read for anything that only works on a screen and rewrite it as speech.
```

- [ ] **Step 2: Write the setup command**

`commands/setup.md`:
```markdown
---
description: One-time setup for research-audio. Choose depth and delivery, and create the config.
argument-hint: (none)
---

Set up research-audio.

**Hard rule:** never ask the user to paste an API key into chat, never read or print the secrets file. Keys go into the env file by the user, outside the conversation.

Scripts run as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"` and need only Node. Every script prints one JSON object.

## 1. Ask the two choices

Use AskUserQuestion, one question per call:

1. **Depth**, chosen once and saved: `concise` (about 2-3 minutes: verdict, top three findings, next step), `deep` (about 7-8 minutes: adds reasoning, key numbers, caveats and what was ruled out), `deeper` (about 15-20 minutes: every finding, sources and open questions). Recommend `deep`.
2. **Delivery**: `email` (the MP3 is emailed to the user through Resend; needs a Resend account and key) or `file` (the MP3 is saved and handed over in this chat session; needs only the OpenAI key). Recommend `file` for anyone who does not already use Resend.

If the user chose `email`, ask in plain chat for the **recipient** address and the **sender** address (for example `Research <audio@yourdomain.com>`). Tell them: Resend only sends from a verified domain or from its shared test sender, and the test sender can only deliver to the address the Resend account was created with. Check Resend's documentation if unsure.

## 2. Save

Run:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --depth <depth> --deliver <email|file> [--recipient <addr> --from "<sender>"]`

If it prints `"ok": false`, show the `problems` and ask again. Otherwise tell the user where the config (`configPath`) and the secrets file (`envPath`) are.

## 3. Keys

If `missing` is not empty, tell the user to open the file at `envPath` and fill in the listed keys after the `=` sign (an `OPENAI_API_KEY` already set in their shell is picked up automatically). Do not ask for the values and do not open the file.

## 4. Say this once

The text of each summary is sent to OpenAI to make the audio and, in email mode, to Resend to deliver it. Sending is automatic, so do not use this plugin on research that must not leave the machine.

## 5. ffmpeg

Run `command -v ffmpeg`. If it is missing, tell the user to run `brew install ffmpeg`. It is optional, but it shrinks the audio about 2x so long summaries fit in an email.

## 6. Test (opt-in)

Offer a test with AskUserQuestion: a 5-second clip (costs under one cent), and in email mode also a test email to their own address. If they accept, rerun the setup command with `--test-clip` (and `--test-email`). Report `testClip.path` and any `error`. If the keys are still missing, say so and stop; they can rerun `/research-audio:setup` later and nothing already saved is lost.
```

- [ ] **Step 3: Write the send command**

`commands/send.md`:
```markdown
---
description: Turn this session's research into a spoken summary (MP3) and deliver it by email or as a file.
argument-hint: [<topic>] [--depth concise|deep|deeper] [--deliver email|file] [--from-script <path>]
---

Create the audio summary for: $ARGUMENTS

Scripts run as `node "${CLAUDE_PLUGIN_ROOT}/scripts/send.mjs" ...` and need only Node. Each prints one JSON object. Never print, echo or ask for API keys. This command is fully automatic: do not ask for confirmation before generating or sending.

Pass any `--depth` / `--deliver` the user gave to every send.mjs call below, so the overrides apply to this run only.

## 1. Re-send an existing script (`--from-script <path>`)

If the user gave `--from-script <path>`, skip to step 4 and add `--no-validate` to the send call.

## 2. Start the run

Topic = the topic text in the arguments if there is one, otherwise a 3 to 6 word title of this session's research.

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/send.mjs" --init --topic "<topic>" [--depth ..] [--deliver ..]`.

- `"stage": "config"` error: show `error` to the user (it says what to fix, usually running `/research-audio:setup`) and stop.
- Otherwise note `scriptPath`, `depth`, `targetWords`.

## 3. Write the script

Invoke the `research-audio` skill (Skill tool) and follow it. Write the spoken script for everything this session found, at `depth`, aiming at `targetWords`, to `scriptPath` with the Write tool.

Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/send.mjs" --check --script "<scriptPath>" [--depth ..]`. If `ok` is false, fix every item in `problems`, rewrite the file, and check again. If it still fails on the second attempt, show the problems to the user and stop.

## 4. Generate and deliver

Run (Bash timeout 600000):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/send.mjs" --script "<scriptPath>" --topic "<topic>" [--depth ..] [--deliver ..] [--no-validate]`

## 5. Report

- `ok: false`, `stage: "voice"`: say the voice step failed with `error`, that the script was kept at `scriptPath`, and that `/research-audio:send --from-script "<scriptPath>"` retries without rewriting. Stop.
- `ok: false`, any other stage: show `error` or `problems` and stop.
- `ok: true`: report in two or three lines: mode delivered (email to the recipient, or file), length in `minutes`, `costUsd`, and `audioPath`. If `fellBack` is true, say the email was not sent and give `reason`. Show any `warnings`.
- In file mode (including a fallback), hand the audio over in the session with SendUserFile (`files: [audioPath]`, `display: "attach"`, `status: "normal"`). If that tool is not available (plain terminal), just give the path.
```

- [ ] **Step 4: Write the README**

`README.md`:
```markdown
# research-audio

A Claude Code plugin that turns a research session into a spoken summary you can listen to on your phone.

1. `/research-audio:setup` (once): pick a depth (concise, deep, deeper) and a delivery mode (email through Resend, or file).
2. `/research-audio:send` (at the end of a session): Claude writes a script for the ear, OpenAI `gpt-4o-mini-tts` (voice `marin`) reads it, and the MP3 is emailed or handed to you as a file.

Options for one run: `--depth concise|deep|deeper`, `--deliver email|file`, `--from-script <path>` (re-send a kept script).

## Requirements

- Node 20+, an OpenAI API key. Email mode also needs a Resend key and a verified sender.
- `ffmpeg` is optional but recommended (shrinks long audio to fit in email).

## Where things live

- Config: `~/.config/research-audio/config.json`; secrets: `~/.config/research-audio/env` (mode 0600). Override the folder with `RESEARCH_AUDIO_HOME`.
- Each run: `<outputDir>/<date>-<topic>/script.txt` and `audio.mp3`.

## Cost

About 1.5 cents per audio minute: roughly 5 cents concise, 12 cents deep, 30 cents deeper.

## Privacy

The script text goes to OpenAI (voice) and, in email mode, to Resend. Sending is automatic.

## Development

`npm test` runs the unit tests (no network, no spend). `RESEARCH_AUDIO_LIVE=1 node tests/live/smoke.mjs` makes one real 1-sentence clip (under one cent) with your `OPENAI_API_KEY`.

Design: `docs/superpowers/specs/2026-10-06-research-audio-design.md`. Plan: `docs/superpowers/plans/2026-10-06-research-audio.md`.
```

- [ ] **Step 5: Write the live smoke test**

`tests/live/smoke.mjs`:
```js
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
```

- [ ] **Step 6: Verify the unit suite, then the live smoke test**

Run: `cd ~/Documents/Code/research-audio && npm test`
Expected: PASS, 0 failures

Run: `cd ~/Documents/Code/research-audio && RESEARCH_AUDIO_LIVE=1 node tests/live/smoke.mjs`
Expected: `OK: <bytes> bytes, about 3s, encoded=true, file /tmp/...` (one real request, under one cent; uses `OPENAI_API_KEY` already in the shell)

- [ ] **Step 7: Commit**

```bash
cd ~/Documents/Code/research-audio
git add skills commands README.md tests/live
git commit -m "feat: setup/send commands, ear-first writing skill, README and live smoke test"
```

- [ ] **Step 8: End-to-end check in a real session (manual, with the user)**

1. Start Claude with the plugin loaded from source: `claude --plugin-dir ~/Documents/Code/research-audio`.
2. First confirm `${CLAUDE_PLUGIN_ROOT}` resolves inside the commands (the setup run below fails with a path error if it does not). Run `/research-audio:setup`, choose `file` delivery and depth `concise`, accept the test clip. Expected: `config.json` and `env` exist under `~/.config/research-audio/`, the env file is mode 0600, and the clip plays.
3. In any session that has some research in it, run `/research-audio:send`. Expected: a folder `<outputDir>/<date>-<topic>/` with `script.txt` and `audio.mp3`, the file is handed over in chat, and the report shows minutes and cost.
4. Re-run `/research-audio:setup` choosing `email` (recipient, sender, Resend key in the env file), then `/research-audio:send --depth concise`. Expected: the email arrives on the phone with the MP3 attached and the script in the body.
5. Break it on purpose: temporarily blank the Resend key and run `/research-audio:send`. Expected: it stops at the start with a message naming `RESEND_API_KEY`, before a script is written.

Report anything that differs from "Expected" instead of working around it.
