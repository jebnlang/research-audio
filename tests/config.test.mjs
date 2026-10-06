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
