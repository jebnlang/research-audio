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
