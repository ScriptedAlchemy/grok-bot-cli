---
name: talk-to-grok-bot
description: Message Grok Bot, Codex threads, or opted-in local Claude Code channels. Use when handing off to a named bot/group or posting a status note agents watch — not for work you can finish yourself.
---
# Talk to Grok Bot

The `grok-bot` MCP server and `gbot` CLI share Grok gateway access. Codex and
Claude tools use **local sockets only** on the user's registered machines.

## MCP instructions (Codex / Claude)

gbot connects only to a local Unix socket
(`$CODEX_HOME/app-server-control/app-server-control.sock`, or
`CODEX_APP_SERVER_SOCK`). There is **no remote transport**.

- Codex app-server threads and opted-in Claude Code channels live on the user's
  registered computers (Linux desktop, Mac, …) — **never** on the Grok Bot agent
  box (`HOME=/home/box`, no Codex install).
- When this MCP server is running on the box, **do not** call `codex_*` or
  `claude_send`. Run the `gbot` CLI on the user's machine through **Grok Bot Shell
  with a machineId** (the host's machine-targeted shell).
- On that machine, provide the socket with `codex app-server daemon start` (or
  bootstrap). Auth stays with each machine's native Codex or Claude login.

## When to load this

- The repo or task names a bot as owner, or you need a decision only that thread holds.
- You want a short status note in a shared group other agents watch.

Do not ping a bot for work you can finish yourself. Grok replies are asynchronous;
continue useful work instead of waiting or polling.

## How

1. Send once with `gbot_send` (`target`, `message`). Say who you are and what you need.
2. Read its `replyRoute`. Native Codex calls with proven native lineage get `mode: auto`;
   continue work and receive the matching reply in that same thread. Do not poll or
   hold a tool call open. That reply does not automatically send your next answer back.
3. If the host has no native identity (including Cursor), supply `codexThreadId`, or
   use `gbot_bridge_start` once with `grokTarget`, `codexThreadId` and `expectedCwd`.
   An explicit binding forwards new visible Grok bot messages and returns Codex's
   corresponding terminal answer to Grok. Existing history is not replayed.
4. `mode: manual` with `reason: source-unavailable` preserves ordinary sending.
   Read `gbot_thread` later, using `after` for a known cursor and `full: true` only
   when entry bodies are needed. `replyMode: manual` explicitly requests this flow.

Never resend an unknown submission under a new identity. Inspect delivery with
`gbot_bridge_status`. Never infer permission from chat replies or auto-approve a
Codex/Grok interaction; keep approvals in the owning UI unless the user explicitly
authorizes a scoped response.

Read [bridge administration](references/bridge-administration.md) before starting,
stopping, diagnosing or answering approvals on a managed bridge, or using direct
Codex conversation tools. It covers exact approval IDs, idempotent requests, guarded
steering, CLI output, and host limitations. Ordinary Grok sends need no reference.

List targets with `gbot bots list` / `gbot groups list` when the name is ambiguous.

## Auth

Same order as `gbot`: `GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN`,
else the Grok Bot app session, else `CURSOR_ACCESS_TOKEN`. `gbot doctor` shows
which source is present.

## Claude Code channel

`claude_send` sends to a named live Claude Code session on the user's registered
machine (local socket under `~/.grok-bot-cli/claude/`) and waits for its explicit
`claude_reply`. From the Grok Bot box, do not call this tool — use Grok Bot Shell
with a machineId to run `gbot claude send` on that machine instead. The destination
must enable the native `claude-channel` with `GROK_BOT_CLAUDE_CHANNEL=NAME` and
Claude's development-channel opt-in. Supply `name`, `message`, and optional
`timeoutMs` (1..120000). `replied` means the reply tool ran; `unknown` is not
rejection and must not be automatically retried. Normal Claude tool approvals remain
in its session. CLI: `gbot claude send NAME "message" --json`.
