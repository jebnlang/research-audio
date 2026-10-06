# Security

## What this plugin can and cannot do

- It runs only when you invoke `/research-audio:setup` or `/research-audio:send`. It installs **no hooks, no MCP servers and no background processes**.
- Its scripts are plain Node with **zero npm dependencies**, so there is no third-party package code to audit.
- The only network calls are to `api.openai.com` (to generate the audio) and, if you choose email delivery, `api.resend.com` (to send it).
- No telemetry, no analytics.

## Your keys

- API keys live in `~/.config/research-audio/env`, created with permissions `0600`. An `OPENAI_API_KEY` already set in your shell is used as is.
- The plugin never asks you to paste a key into the chat, never prints a key, and redacts keys from error messages.
- Never commit a key. `.gitignore` excludes `.env*`, `*.key`, `*.pem` and generated audio, and the repository's full history was scanned for secret-shaped strings before it was published (the only match is an obviously fake placeholder key used in a redaction test).

## Your data

The text of each spoken summary is sent to OpenAI to produce the audio and, in email mode, to Resend to deliver it. Sending is automatic, so do not use the plugin on research that must not leave your machine. Generated scripts and audio are stored locally under the output folder you chose at setup.

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security tab → Report a vulnerability** on this repository. Do not open a public issue for a vulnerability or include real keys in any report.
