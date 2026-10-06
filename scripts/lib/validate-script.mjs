export const TARGET_WORDS = { concise: 400, deep: 1200, deeper: 3000 };
export const TOLERANCE = 0.25;

const MARKDOWN = [
  [/^\s{0,3}#{1,6}\s/m, 'a markdown heading'],
  [/^\s*[-*•]\s+/m, 'a bullet list'],
  [/^\s*\d+[.)]\s+/m, 'a numbered list'],
  [/\|[^\n]*\|/, 'a table row'],
  [/\*\*|__/, 'bold markers'],
  [/`/, 'a backtick'],
  [/\]\(/, 'a markdown link'],
];
const URL_PATTERN = /https?:\/\/|www\./i;

export function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function validateScript(text, depth) {
  const target = TARGET_WORDS[depth];
  if (!target) throw new Error(`Unknown depth "${depth}"`);
  const words = countWords(text);
  const problems = [];
  if (words === 0) {
    problems.push('the script is empty');
  } else {
    const min = Math.round(target * (1 - TOLERANCE));
    const max = Math.round(target * (1 + TOLERANCE));
    if (words < min) problems.push(`too short: ${words} words, ${depth} needs ${min}-${max} (target ${target})`);
    else if (words > max) problems.push(`too long: ${words} words, ${depth} needs ${min}-${max} (target ${target})`);
  }
  for (const [pattern, label] of MARKDOWN) {
    if (pattern.test(text)) problems.push(`contains ${label}; write it as plain spoken prose`);
  }
  if (URL_PATTERN.test(text)) problems.push('contains a web address; name the source instead of reading a URL aloud');
  return { ok: problems.length === 0, words, target, problems };
}
