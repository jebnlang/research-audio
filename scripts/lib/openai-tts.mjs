export const TTS_URL = 'https://api.openai.com/v1/audio/speech';
export const DEFAULT_MODEL = 'gpt-4o-mini-tts';
export const TONE_INSTRUCTIONS =
  'Speak as a calm, clear briefing narrator. Warm, steady pace, natural pauses between paragraphs, no theatrics.';

export class SynthesisError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function synthesizeChunk(text, {
  apiKey,
  voice = 'marin',
  model = DEFAULT_MODEL,
  instructions = TONE_INSTRUCTIONS,
  fetchImpl = fetch,
  sleep = defaultSleep,
  maxRetries = 3,
  shouldStop,
}) {
  const body = JSON.stringify({ model, voice, input: text, instructions, response_format: 'mp3' });
  const redact = (s) => (apiKey ? s.split(apiKey).join('[key]') : s);
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(1000 * 2 ** (attempt - 1));
      if (shouldStop && shouldStop()) throw lastError;
    }
    let res;
    try {
      res = await fetchImpl(TTS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      lastError = new SynthesisError(`Network error talking to OpenAI: ${redact(err.message)}`, { retryable: true });
      continue;
    }
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 401 || res.status === 403) {
      throw new SynthesisError(`OpenAI rejected the API key (${res.status}). Check OPENAI_API_KEY.`, { status: res.status });
    }
    const detail = redact(await res.text()).slice(0, 200);
    const retryable = res.status === 429 || res.status >= 500;
    lastError = new SynthesisError(`OpenAI returned ${res.status}: ${detail}`, { status: res.status, retryable });
    if (!retryable) throw lastError;
  }
  throw lastError;
}
