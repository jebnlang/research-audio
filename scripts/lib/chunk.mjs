function splitWords(sentence, max) {
  const out = [];
  let cur = '';
  for (let word of sentence.split(/\s+/)) {
    while (word.length > max) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (cur && cur.length + 1 + word.length > max) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

function splitLong(paragraph, max) {
  const out = [];
  let cur = '';
  const flush = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    const pieces = sentence.length > max ? splitWords(sentence, max) : [sentence];
    for (const piece of pieces) {
      if (cur && cur.length + 1 + piece.length > max) flush();
      cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  flush();
  return out;
}

export function chunkText(text, maxChars = 1500) {
  const units = [];
  for (const paragraph of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (paragraph.length <= maxChars) units.push(paragraph);
    else units.push(...splitLong(paragraph, maxChars));
  }
  const chunks = [];
  let cur = '';
  for (const unit of units) {
    if (cur && cur.length + 2 + unit.length > maxChars) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${unit}` : unit;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
