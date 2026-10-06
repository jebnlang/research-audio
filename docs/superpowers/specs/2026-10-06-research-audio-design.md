# research-audio — design

Date: 2026-10-06
Status: draft for review

## Purpose

At the end of a research session, turn everything the session found into a spoken summary and get it to the user's phone, so they can listen instead of read.

Success: the user runs one command, and a few minutes later has an MP3 of the research they can play on a walk, either in their inbox or as a file handed to them in the chat session.

## Decisions (agreed with the user)

| Topic | Decision |
|---|---|
| Audience | Built for Ben first, with per-user config so it can go into the marketplace without a rewrite |
| Trigger | Manual command at the end of a session. No hooks, no auto-trigger |
| Depth | Concise / Deep / Deeper, chosen **once at setup** and saved. One-run override via `--depth` |
| Voice | OpenAI `gpt-4o-mini-tts`, voice `marin`, with a "calm briefing narrator" instruction. Picked by ear in a bake-off against `tts-1-hd` / `onyx` and `cedar` |
| Delivery | `email` (Resend API) or `file` (saved locally, handed over in the chat session). Chosen at setup. Override via `--deliver` |
| Review gate | None. Fully automatic. The email also carries the written script as text for spot-checking |
| Where it lives | Local plugin repo `~/Documents/Code/research-audio`, work on main. Marketplace only after it works |

Cost reference (OpenAI, about 150 spoken words/min): `gpt-4o-mini-tts` is about $0.015 per audio minute, so roughly $0.05 / $0.12 / $0.30 for concise / deep / deeper.

## Non-goals (v1)

- Transcript fallback for long sessions whose early context was compacted
- Multiple recipients
- Two-host "podcast" audio and additional voice providers (the voice interface leaves room for Gemini)
- Scheduling and session-end hooks
- A hosted link in place of an attachment
- Non-English summaries (the voice model speaks other languages, but quality is untested)

## Layout

```
research-audio/
  .claude-plugin/plugin.json
  commands/setup.md                one-time: depth, delivery, keys
  commands/send.md                 end of session: summarize -> voice -> deliver
  skills/research-audio/SKILL.md   how to write for the ear + the three depth rubrics
  scripts/synthesize.mjs           chunk text -> TTS -> join -> 64 kbps mono MP3
  scripts/deliver.mjs              email via Resend, or save the file and report the path
  scripts/lib/config.mjs           read and validate config
  docs/superpowers/specs/          this document
```

## Config

Two files outside the repo, in `~/.config/research-audio/`:

- `config.json` (non-secret):
  - `depth`: `concise` | `deep` | `deeper`
  - `deliver`: `email` | `file`
  - `recipient`, `from` (email mode only)
  - `outputDir`: where MP3s and scripts are kept
  - `voice`: default `marin`
- `env` (secrets, `chmod 600`):
  - `OPENAI_API_KEY`
  - `RESEND_API_KEY` (email mode only)

Secrets are never typed into chat, never logged and never echoed.

## Setup flow — `/research-audio:setup`

1. Ask the depth (concise / deep / deeper), then the delivery mode (email / file).
2. In email mode only: ask the recipient and the sender address.
3. Write `config.json` and an `env` template. Tell the user which lines to fill in. Reuse `OPENAI_API_KEY` if it is already in the shell environment. Never ask the user to paste a key into chat.
4. Offer, opt-in, a 5-second test clip (under one cent) and, in email mode, a test email to the user's own address.
5. State once that the script text goes to OpenAI for the voice and, in email mode, to Resend for delivery.
6. Re-running setup edits the existing settings.

## Send flow — `/research-audio:send`

Flags: `--depth concise|deep|deeper`, `--deliver email|file`, `--from-script <path>`.

1. **Load config.** If setup has not been run, stop with "run `/research-audio:setup` first". Apply flag overrides for this run only.
2. **Write the spoken script** (skipped with `--from-script`). Claude drafts it from what the session actually found, following the skill's rubric:

   | Depth | Target | Content |
   |---|---|---|
   | Concise | ~400 words (2-3 min) | Verdict, top three findings, next step |
   | Deep | ~1,200 words (7-8 min) | Adds the reasoning, key numbers, caveats, what was ruled out |
   | Deeper | ~3,000 words (18-20 min) | Every finding in order, sources by name, open questions |

   Writing rules (the main quality lever):
   - Open with the verdict, and signpost the structure ("three things stand out").
   - No tables, URLs or markdown. Numbers are spoken naturally, acronyms are spelled the way they should sound, sources are named rather than linked.
   - Only facts present in the session go in. Uncertainty is stated as uncertainty.
3. **Validate the script** before spending anything: word count within about 25% of the depth target, and no markdown or URLs left in. On failure, rewrite once.
4. **Save** `script.txt` under `outputDir/<date>-<topic>/`.
5. **Synthesize** (`scripts/synthesize.mjs`): split at paragraph breaks into chunks of about 1,500 characters, never mid-sentence. Use the same tone instruction on every chunk. Run up to three requests at a time, retry 429 and 5xx with backoff. Join the chunks and re-encode to 64 kbps mono with `ffmpeg` (about 0.5 MB per minute, so roughly 10 MB for 20 minutes, under Gmail's 25 MB limit). Output: `audio.mp3`.
6. **Deliver** (`scripts/deliver.mjs`):
   - `email`: Resend sends the MP3 as an attachment. Subject: "Research audio (8 min): <topic>". Body: topic, depth, and the written script as text.
   - `file`: save the MP3, report the path, and in the desktop app hand the file over in the chat session.
7. **Report** in the session: what was delivered and where, duration, rough cost.

## Failure handling

A failure never silently drops audio the user has already paid for.

| Situation | Behavior |
|---|---|
| No config, or a missing key | Stop before any work, with the exact fix |
| Script off-length, or markdown/URLs remain | Rewrite once, before any voice spend |
| OpenAI 429 / 5xx | Retry three times with backoff |
| OpenAI 401, or chunks still failing after retries | Abort and keep `script.txt`. `--from-script <path>` re-runs voice and delivery without rewriting |
| `ffmpeg` missing | Send the native MP3, and warn when it is over about 15 MB |
| File too big for email (over about 20 MB) | Switch to file mode and tell the user |
| Resend failure | Fall back to file mode and tell the user why |

## Known limits

- The summary is built from what is in the session's context. In a very long session that has been compacted, early findings can be thin.
- Fully automatic means client-sensitive research is sent to OpenAI (and Resend) without a prompt. Setup states this once; there is no per-run reminder.
- Depends on `ffmpeg` for the size target. It is optional but strongly advised.

## Testing (test-first)

- **Unit tests:** chunker (no mid-sentence splits, never over the cap); script validator (markdown, URLs, length); config loader; size-fallback rules.
- **Mocked HTTP tests:** OpenAI retry and backoff; Resend failure falls back to file mode. No spend.
- **Opt-in live smoke test:** a 5-second clip with a real key, under one cent. Run by hand, not part of the default test run.
