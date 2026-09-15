---
name: talk-to-grok-bot
description: Message a Grok Bot bot or group and read its reply with the gbot_send and gbot_thread tools. Use when a task needs Grok Bot's help, a handoff to a specialist bot, or a status note in a shared group.
---
# Talk to Grok Bot

Grok Bot runs named bots and groups in the Grok Bot desktop app. This plugin
exposes two MCP tools on the `grok-bot` server that talk to the same gateway
the `gbot` CLI uses.

## When to ping a bot

- A repository or task names a bot as its owner. Route questions and handoffs there.
- You need a decision or context only a human-run bot conversation holds.
- You want to leave a short status note in a group other agents watch.

Do not ping a bot for work you can finish yourself. Bots answer asynchronously,
so never block a turn waiting for a reply.

## Naming the target

`target` is a bot or group name or id, matched case-insensitively. `General`
is the catch-all bot. Prefer the specialist bot when the repository's
AGENTS.md names one. An ambiguous or unknown name fails with the gateway's
error text; list candidates with `gbot bots list` or `gbot groups list`.

## Message format

Keep the first line to who you are and what you need, then the details:

```text
[codex @ grok-bot-cli#25] Need a decision: keep the changeset for a plugin-only PR?
Context: the plugin lives under plugin/ and is not packed into the npm tarball.
```

Reply threads are read with `gbot_thread` (`limit` defaults to 20). A bot
reply appears as a `send-message` entry; your own message is a `message`
entry with `role: user`.

## Auth

The tools resolve credentials the same way `gbot` does, in this order:

1. `GROK_BOT_GATEWAY_URL` + `GROK_BOT_GATEWAY_TOKEN` (explicit gateway).
2. The Grok Bot desktop app session on this machine (sign in once; no env needed).
3. `CURSOR_ACCESS_TOKEN` (the CLI calls `EnsureSandBox` to obtain a gateway).

The MCP server needs outbound HTTPS to the gateway host and read access to
the app-session file. `gbot doctor` shows which source is present.
