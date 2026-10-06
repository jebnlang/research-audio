---
description: Turn this session's research into a spoken summary (MP3) and deliver it by email or as a file.
argument-hint: [<topic>] [--depth concise|deep|deeper] [--deliver email|file] [--from-script <path>]
---

Create the audio summary for: $ARGUMENTS

Scripts run as `node "${CLAUDE_PLUGIN_ROOT}/scripts/send.mjs" ...` and need only Node. Each prints one JSON object. Never print, echo or ask for API keys. This command is fully automatic: do not ask for confirmation before generating or sending.

Pass any `--depth` / `--deliver` the user gave to every send.mjs call below, so the overrides apply to this run only.

## 1. Re-send an existing script (`--from-script <path>`)

If the user gave `--from-script <path>`, skip to step 4 and add `--no-validate` to the send call. In that case the topic is the topic text in the arguments if there is one; otherwise omit `--topic` (the script derives a readable one from the run folder name).

## 2. Start the run

Topic = the topic text in the arguments if there is one, otherwise a 3 to 6 word title of this session's research.

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/send.mjs" --init --topic "<topic>" [--depth ..] [--deliver ..]`.

- `"stage": "config"` error: show `error` to the user (it says what to fix, usually running `/research-audio:setup`) and stop.
- Otherwise note `scriptPath`, `depth`, `targetWords`.

## 3. Write the script

Invoke the `research-audio` skill (Skill tool) and follow it. Write the spoken script for everything this session found, at `depth`, aiming at `targetWords`, to `scriptPath` with the Write tool.

Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/send.mjs" --check --script "<scriptPath>" [--depth ..]`. If `ok` is false, fix every item in `problems`, rewrite the file, and check again. If it still fails on the second attempt, show the problems to the user and stop.

## 4. Generate and deliver

Run (Bash timeout 600000):
`node "${CLAUDE_PLUGIN_ROOT}/scripts/send.mjs" --script "<scriptPath>" --topic "<topic>" [--depth ..] [--deliver ..] [--no-validate]`

## 5. Report

- `ok: false`, `stage: "voice"`: say the voice step failed with `error`, that the script was kept at `scriptPath`, and that `/research-audio:send --from-script "<scriptPath>"` retries without rewriting. Stop.
- `ok: false`, any other stage (including `internal`): show `error` or `problems` and stop. If the run folder from step 2 contains an `audio.mp3`, tell the user where it is, because audio that was already generated is never deleted.
- `ok: true`: report in two or three lines: mode delivered (email to the recipient, or file), length in `minutes`, `costUsd`, and `audioPath`. If `fellBack` is true, say the email was not sent and give `reason`. Show any `warnings`.
- In file mode (including a fallback), hand the audio over in the session with SendUserFile (`files: [audioPath]`, `display: "attach"`, `status: "normal"`). If that tool is not available (plain terminal), just give the path.
