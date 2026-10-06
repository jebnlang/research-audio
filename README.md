# research-audio

**Turn a Claude Code research session into a spoken summary you can listen to on your phone.**

You finish a research session. You run one command. Claude writes a script for the ear, a text-to-speech voice reads it, and the MP3 lands in your inbox (or in the chat) a minute later. Put your earbuds in and hear what the research found.

```
research session  →  /research-audio:send  →  spoken script  →  MP3  →  email or file
```

## What you get

- **One command at the end of a session:** `/research-audio:send`.
- **Three depths, chosen once:** concise (about 2–3 minutes), deep (about 7–8), deeper (about 15–20). You pick it during setup, and it applies to every run until you change it.
- **Two ways to receive it:** emailed to you through [Resend](https://resend.com), or saved as a file and handed to you in the chat. File mode needs no email account at all.
- **Written for listening:** no tables, URLs or markdown read aloud. The script opens with the verdict, signposts its structure, and says what is uncertain.
- **Cheap:** about 1.5 US cents per audio minute with OpenAI's `gpt-4o-mini-tts` (roughly 5¢ concise, 12¢ deep, 30¢ deeper).

## Install

You need [Claude Code](https://code.claude.com), Node.js 20+, and an [OpenAI API key](https://platform.openai.com/api-keys).

```bash
claude plugin marketplace add jebnlang/research-audio
claude plugin install research-audio@research-audio
```

Or from inside a Claude Code session:

```
/plugin marketplace add jebnlang/research-audio
/plugin install research-audio@research-audio
```

Optional but recommended: [`ffmpeg`](https://ffmpeg.org) (`brew install ffmpeg` on macOS). It shrinks the audio about 2× so long summaries fit in an email.

## Quick start

1. **Set up once:** run `/research-audio:setup`. It asks two questions: which depth, and email or file. It then creates a config and a private key file, and tells you which keys to fill in. It never asks you to paste a key into the chat.
2. **Add your key(s)** to `~/.config/research-audio/env` (the setup tells you the exact path):
   ```
   OPENAI_API_KEY=sk-...
   RESEND_API_KEY=re_...      # email mode only
   ```
   An `OPENAI_API_KEY` that is already set in your shell is picked up automatically.
3. **Do some research** in a Claude Code session, as you normally would.
4. **At the end, run** `/research-audio:send`. In a minute or two you have an MP3.

Run `/research-audio:setup` again any time to change depth or delivery.

## Options for one run

```
/research-audio:send [topic] [--depth concise|deep|deeper] [--deliver email|file] [--from-script <path>]
```

| Option | What it does |
| --- | --- |
| `topic` | Names the run and the email subject. Defaults to a short title of your research. |
| `--depth` | Use a different depth for this run only. |
| `--deliver` | Use a different delivery mode for this run only. |
| `--from-script <path>` | Re-run the voice and delivery for a script that was already written, without rewriting it. Useful after a failed email. |

## Depth levels

| Depth | Length | What you hear |
| --- | --- | --- |
| **concise** | ~400 words, 2–3 min | The verdict, the three findings that matter most, the next step |
| **deep** | ~1,200 words, 7–8 min | Adds the reasoning, key numbers, caveats and what was ruled out |
| **deeper** | ~3,000 words, 15–20 min | Every finding in order, sources by name, open questions |

## Delivery modes

**File** (the default recommendation): the MP3 and its script are saved under your output folder (`~/research-audio/<date>-<topic>/` by default), and in the Claude desktop app the file is handed to you in the chat. Needs only the OpenAI key.

**Email:** the MP3 is attached to an email sent through the Resend API, with the written script in the body. You need a Resend account and API key, plus a sender address Resend allows: a verified domain, or Resend's shared test sender (which, as I understand it, can only deliver to the address your Resend account was created with; check Resend's docs). If Resend fails for any reason, or the audio is over 20 MB, the plugin falls back to file mode and tells you why. Audio you already paid for is never thrown away.

## Where things live

| What | Where |
| --- | --- |
| Settings | `~/.config/research-audio/config.json` |
| API keys | `~/.config/research-audio/env` (permissions `0600`) |
| Each run | `<output folder>/<date>-<topic>/script.txt` and `audio.mp3` |

Set `RESEARCH_AUDIO_HOME` to use a different config folder.

## Privacy and security

- The text of each summary is sent to **OpenAI** to generate the audio and, in email mode, to **Resend** to deliver it. Sending is automatic, so do not use this plugin on research that must not leave your machine.
- Keys are never typed into chat, never printed, and redacted from error messages.
- The plugin installs no hooks, no MCP servers and no background processes. Its scripts are plain Node with **zero npm dependencies**. It talks only to `api.openai.com` and, if you choose email, `api.resend.com`. No telemetry.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "research-audio is not set up yet" | Run `/research-audio:setup`. |
| "Missing OPENAI_API_KEY" (or `RESEND_API_KEY`) | Add the key to `~/.config/research-audio/env` as `KEY=value`. |
| "OpenAI rejected the API key" | The key is wrong or revoked; replace it in the env file. |
| Email not sent, "Resend returned 403…" | Your sender domain is not verified in Resend, or the recipient is not allowed for the test sender. The audio was kept as a file. Fix it, then run `/research-audio:send --from-script <path>`. |
| Audio is large / "ffmpeg is not installed" | Install `ffmpeg`; the plugin then re-encodes to a small 64 kbps mono file. |
| Script rejected as too long/short | The plugin rewrites it once automatically. If it still fails, try `--depth` with a different level. |

## Status and limitations

Early release (0.1.0). The core pipeline is covered by 97 unit tests and a live OpenAI smoke test. Email delivery through Resend is unit-tested against the documented API but has not yet been exercised against a real Resend account by the author, so treat the first email as a test. Known limitations:

- The summary is built from what is in the session's context. In a very long session whose early parts were compacted, early findings can be thin.
- English-language summaries are the tested case.
- One recipient only.

A short list of deferred small improvements is in [docs/superpowers/deferred-minors.md](docs/superpowers/deferred-minors.md).

## Development

```bash
npm test                                  # 97 unit tests, no network, no spend
RESEARCH_AUDIO_LIVE=1 node tests/live/smoke.mjs   # one real clip, under a cent
claude plugin validate --strict .         # check the plugin and marketplace manifests
claude --plugin-dir .                     # try the plugin from source
```

The design and implementation plan are in [docs/superpowers/specs](docs/superpowers/specs/2026-10-06-research-audio-design.md) and [docs/superpowers/plans](docs/superpowers/plans/2026-10-06-research-audio.md).

To release a new version: bump `version` in `.claude-plugin/plugin.json` (users keep their cached copy until it changes), then tag it with `claude plugin tag --push`.

## License

[MIT](LICENSE) © 2026 Ben Lang
