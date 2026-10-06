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

test('FINAL FIX: a long Resend key echoed past the 200-char cut is still fully redacted', async () => {
  const key = 're_' + 'Zz9Yy8Xx7W'.repeat(15);
  const f = scriptedFetch(fakeResponse(401, 'y'.repeat(100) + key));
  const r = await deliver(base({ fetchImpl: f, secrets: { RESEND_API_KEY: key } }));
  assert.ok(!r.reason.includes(key.slice(0, 20)));
  assert.ok(!r.reason.includes(key.slice(-20)));
});
