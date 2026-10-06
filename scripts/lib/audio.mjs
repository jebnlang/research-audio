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
