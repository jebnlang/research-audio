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
