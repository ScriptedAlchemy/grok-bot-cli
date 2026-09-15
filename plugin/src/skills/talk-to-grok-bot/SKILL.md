---
name: talk-to-grok-bot
description: Send or read a Grok Bot thread via gbot_send/gbot_thread. Use when handing off to a named bot/group or posting a status note agents watch — not for work you can finish yourself.
---
# Talk to Grok Bot

MCP tools on the `grok-bot` server use the same gateway as the `gbot` CLI.

## When to load this

- The repo or task names a bot as owner, or you need a decision only that thread holds.
- You want a short status note in a shared group other agents watch.

Do not ping a bot for work you can finish yourself. Replies are asynchronous — never block a turn waiting.

## How

1. `gbot_send` with `target` (name or id) and `message` (first line: who you are + what you need).
2. Later, call `gbot_thread` with the same `target` (`limit` defaults to 40). The default receipt has only `summary`, `cursor`, `entryCount`, and `gapReset`; it never includes entries.
3. Poll with the previous `cursor` as `after`. This is exclusive and client-side: `entryCount: 0` means no change.
4. Pass `full: true` only when entry bodies are needed inline; it adds bounded `entries` to structured content, not to `Agent.Text`. If `gapReset` is true, repeat the same call with `full: true` to inspect the bounded reset snapshot.

Bot replies are `send-message` entries; yours are `message` with `role: user`.

List targets with `gbot bots list` / `gbot groups list` when the name is ambiguous.

## Auth

Same order as `gbot`: explicit `GROK_BOT_GATEWAY_*`, else Grok Bot app session, else `CURSOR_ACCESS_TOKEN`. `gbot doctor` shows which source is present.
