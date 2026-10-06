---
description: One-time setup for research-audio. Choose depth and delivery, and create the config.
argument-hint: (none)
---

Set up research-audio.

**Hard rule:** never ask the user to paste an API key into chat, never read or print the secrets file. Keys go into the env file by the user, outside the conversation.

Scripts run as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"` and need only Node. Every script prints one JSON object.

## 1. Ask the two choices

Use AskUserQuestion, one question per call:

1. **Depth**, chosen once and saved: `concise` (about 2-3 minutes: verdict, top three findings, next step), `deep` (about 7-8 minutes: adds reasoning, key numbers, caveats and what was ruled out), `deeper` (about 15-20 minutes: every finding, sources and open questions). Recommend `deep`.
2. **Delivery**: `email` (the MP3 is emailed to the user through Resend; needs a Resend account and key) or `file` (the MP3 is saved and handed over in this chat session; needs only the OpenAI key). Recommend `file` for anyone who does not already use Resend.

If the user chose `email`, ask in plain chat for the **recipient** address and the **sender** address (for example `Research <audio@yourdomain.com>`). Tell them: Resend only sends from a verified domain or from its shared test sender, and the test sender can only deliver to the address the Resend account was created with. Check Resend's documentation if unsure.

## 2. Save

Run:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --depth <depth> --deliver <email|file> [--recipient <addr> --from "<sender>"]`

If it prints `"ok": false`, show the `problems` and ask again. Otherwise tell the user where the config (`configPath`) and the secrets file (`envPath`) are.

## 3. Keys

If `missing` is not empty, tell the user to open the file at `envPath` and fill in the listed keys after the `=` sign (an `OPENAI_API_KEY` already set in their shell is picked up automatically). Do not ask for the values and do not open the file.

## 4. Say this once

The text of each summary is sent to OpenAI to make the audio and, in email mode, to Resend to deliver it. Sending is automatic, so do not use this plugin on research that must not leave the machine.

## 5. ffmpeg

Run `command -v ffmpeg`. If it is missing, tell the user to run `brew install ffmpeg`. It is optional, but it shrinks the audio about 2x so long summaries fit in an email.

## 6. Test (opt-in)

Offer a test with AskUserQuestion: a 5-second clip (costs under one cent), and in email mode also a test email to their own address. If they accept, rerun the setup command with `--test-clip` (and `--test-email`). Report `testClip.path` and any `error`. If the keys are still missing, say so and stop; they can rerun `/research-audio:setup` later and nothing already saved is lost.
