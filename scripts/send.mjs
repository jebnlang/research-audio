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

export function topicFromRunDir(name) {
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ').trim() || 'research';
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
    if (!fs.statSync(scriptPath).isFile()) return fail('usage', `script is not a file: ${scriptPath}`);
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
    const topic = args.topic || topicFromRunDir(path.basename(runDir));

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

    let delivery;
    try {
      delivery = await deliver({
        mode: cfg.deliver, audioPath, scriptText, topic, depth: cfg.depth, seconds: audio.seconds,
        config: cfg, secrets, fetchImpl, attachmentName: `${path.basename(runDir)}.mp3`,
      });
    } catch (err) {
      delivery = { requested: cfg.deliver, mode: 'file', fellBack: true, reason: `delivery failed: ${err.message}`, path: audioPath };
    }

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
    return fail('internal', err.message);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  const { exitCode, result } = await runSend({ argv: process.argv.slice(2) });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = exitCode;
}
