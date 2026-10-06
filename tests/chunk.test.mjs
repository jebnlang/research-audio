import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../scripts/lib/chunk.mjs';
import { sentences } from './helpers.mjs';

const norm = (s) => s.replace(/\s+/g, ' ').trim();

test('empty or whitespace-only text gives no chunks', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('  \n\n  '), []);
});

test('short text is a single chunk', () => {
  assert.deepEqual(chunkText('Hello there.\n\nSecond paragraph.'), ['Hello there.\n\nSecond paragraph.']);
});

test('paragraph breaks are the preferred boundary', () => {
  const a = 'A'.repeat(900);
  const b = 'B'.repeat(900);
  assert.deepEqual(chunkText(`${a}\n\n${b}`), [a, b]);
});

test('an over-long paragraph splits at sentence ends, never mid-sentence', () => {
  const text = sentences(1000);
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 1500, `chunk of ${c.length} chars`);
    assert.ok(c.endsWith('.'), `chunk does not end at a sentence: ...${c.slice(-20)}`);
  }
  assert.equal(norm(chunks.join(' ')), norm(text));
});

test('a long run of words with no punctuation still respects the cap', () => {
  const text = 'word '.repeat(400).trim();
  const chunks = chunkText(text);
  for (const c of chunks) assert.ok(c.length <= 1500);
  assert.equal(norm(chunks.join(' ')), norm(text));
});

test('REVIEW FOCUS: a 4000-character unbroken token (a pasted URL) cannot exceed the cap', () => {
  const text = 'x'.repeat(4000);
  const chunks = chunkText(text);
  for (const c of chunks) assert.ok(c.length <= 1500);
  assert.equal(chunks.join(''), text);
});

test('a custom cap is honoured', () => {
  for (const c of chunkText(sentences(60), 100)) assert.ok(c.length <= 100);
});
