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
    const detail = redact(await res.text()).slice(0, 200);
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
