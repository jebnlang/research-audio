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
