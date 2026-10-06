# research-audio

A Claude Code plugin that turns a research session into a spoken summary you can listen to on your phone.

1. `/research-audio:setup` (once): pick a depth (concise, deep, deeper) and a delivery mode (email through Resend, or file).
2. `/research-audio:send` (at the end of a session): Claude writes a script for the ear, OpenAI `gpt-4o-mini-tts` (voice `marin`) reads it, and the MP3 is emailed or handed to you as a file.

Options for one run: `--depth concise|deep|deeper`, `--deliver email|file`, `--from-script <path>` (re-send a kept script).

## Requirements

- Node 20+, an OpenAI API key. Email mode also needs a Resend key and a verified sender.
- `ffmpeg` is optional but recommended (shrinks long audio to fit in email).

## Where things live

- Config: `~/.config/research-audio/config.json`; secrets: `~/.config/research-audio/env` (mode 0600). Override the folder with `RESEARCH_AUDIO_HOME`.
- Each run: `<outputDir>/<date>-<topic>/script.txt` and `audio.mp3`.

## Cost

About 1.5 cents per audio minute: roughly 5 cents concise, 12 cents deep, 30 cents deeper.

## Privacy

The script text goes to OpenAI (voice) and, in email mode, to Resend. Sending is automatic.

## Development

`npm test` runs the unit tests (no network, no spend). `RESEARCH_AUDIO_LIVE=1 node tests/live/smoke.mjs` makes one real 1-sentence clip (under one cent) with your `OPENAI_API_KEY`.

Design: `docs/superpowers/specs/2026-10-06-research-audio-design.md`. Plan: `docs/superpowers/plans/2026-10-06-research-audio.md`.
