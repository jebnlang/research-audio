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
