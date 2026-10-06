# Deferred minor findings (final review, 2026-10-06)

Found by the whole-branch review and deliberately not fixed in v1. None loses data or leaks secrets.

1. `scripts/lib/chunk.mjs`: paragraph breaks written as CRLF (`\r\n\r\n`) are not recognised, so a CRLF script loses its paragraph pauses (content and the 1500-char cap are intact). Split on `/\r?\n(?:[ \t]*\r?\n)+/`.
2. `scripts/lib/validate-script.mjs`: a prose line that starts with a number and a period ("2. Not a list...") is flagged as a numbered list and costs the one allowed rewrite. Consider requiring two consecutive list lines.
3. `scripts/lib/openai-tts.mjs`: a 200 response with an empty body is accepted as audio, silently dropping that chunk. Guard with a minimum length and retry.
4. `scripts/send.mjs`: `--from-script` always re-synthesizes, so after a Resend fallback the only way to email is to pay for the voice again. Add a deliver-existing-`audio.mp3` option.
5. `scripts/synthesize.mjs`: without ffmpeg the output is concatenated independent MP3 streams; some players show a wrong duration or glitch at joins. Only size is warned about; add a quality warning when `encoded` is false.
6. `scripts/synthesize.mjs`: the raw temp file (`audio.mp3.raw.mp3`) sits beside the deliverable and is left behind if the process is killed mid-ffmpeg. Use `os.tmpdir()`.
7. `scripts/send.mjs`: `makeRunDir` is check-then-create, so two concurrent `--init` calls for the same topic and day can pick the same folder.
8. `scripts/send.mjs`: `parseArgs` accepts a flag as a value (`--topic --depth deep`). Reject values starting with `--`.
9. `scripts/setup.mjs`: the env file is rewritten (non-atomically) on every setup run even when nothing changes. Write only when lines were added.
10. Doc drift: "15-20 minutes" for deeper in `commands/setup.md` and the skill vs "18-20" in the spec; README says "1-sentence clip" for the live smoke test where the plan says 5 seconds.

Also noted by the reviewer, spec-level and not a bug: Gmail's 25 MB limit applies to the base64-encoded message, so a 19-20 MB attachment (the 20 MB raw threshold) could bounce at the recipient. Real 64 kbps audio stays near 0.5 MB per minute, so this only matters for extreme lengths.
