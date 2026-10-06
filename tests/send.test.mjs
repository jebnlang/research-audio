import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSend, slugify, makeRunDir, parseArgs, topicFromRunDir } from '../scripts/send.mjs';
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

test('FINAL FIX: --script pointing at a directory is a usage error, not a stack trace', async () => {
  const { env, outputDir } = setupHome();
  const dir = makeRunDir(outputDir, 'T');
  const { exitCode, result } = await runSend({ argv: ['--script', dir], env });
  assert.equal(exitCode, 1);
  assert.equal(result.stage, 'usage');
  assert.match(result.error, /not a file/);
});

test('FINAL FIX: an unexpected error becomes one JSON failure with stage "internal"', async () => {
  const { env, home } = setupHome();
  const blocker = path.join(home, 'blocker');
  fs.writeFileSync(blocker, 'a file, not a folder');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ depth: 'deep', deliver: 'file', voice: 'marin', outputDir: path.join(blocker, 'sub') }));
  const { exitCode, result } = await runSend({ argv: ['--init', '--topic', 'T'], env });
  assert.equal(exitCode, 1);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'internal');
});

test('FINAL FIX: if delivery itself throws after synthesis, the audio is reported, not lost', async () => {
  const { env, outputDir } = setupHome({ depth: 'concise', deliver: 'email' });
  const broken = { ...fakeResponse(403, 'nope'), text: async () => { throw new Error('socket hang up'); } };
  const f = scriptedFetch((url) => (url.includes('openai') ? fakeResponse(200, 'AUDIO') : broken));
  const p = writeScript(makeRunDir(outputDir, 'T'), sentences(400));
  const { exitCode, result } = await runSend({ argv: ['--script', p], env, fetchImpl: f, ffmpeg: NO_FFMPEG });
  assert.equal(exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'file');
  assert.equal(result.fellBack, true);
  assert.match(result.reason, /socket hang up/);
  assert.ok(fs.existsSync(result.audioPath));
});

test('FINAL FIX: topicFromRunDir turns a run folder name back into a readable topic', () => {
  assert.equal(topicFromRunDir('2026-10-06-voice-engines'), 'voice engines');
  assert.equal(topicFromRunDir('2026-10-06-research'), 'research');
  assert.equal(topicFromRunDir('weird'), 'weird');
});

test('FINAL FIX: on a --from-script retry without --topic the email subject is readable, not the folder name', async () => {
  const { env, outputDir } = setupHome({ depth: 'concise', deliver: 'email' });
  const f = router();
  const p = writeScript(makeRunDir(outputDir, 'Voice engines', new Date(2026, 9, 6)), sentences(400));
  await runSend({ argv: ['--script', p, '--no-validate'], env, fetchImpl: f, ffmpeg: NO_FFMPEG });
  const body = JSON.parse(resendCalls(f)[0].init.body);
  assert.match(body.subject, /: voice engines$/);
});
