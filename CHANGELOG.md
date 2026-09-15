# grok-bot-cli

## 0.3.0

### Minor Changes

- 82badce: Add `gbot codex status`, `gbot codex list-threads [--limit N]`, and `gbot codex send <threadId> <message...>`: attach to the local Codex app-server daemon socket (`$CODEX_HOME/app-server-control/app-server-control.sock`) with a built-in WebSocket client, list threads, and start a turn with documented JSON-RPC (`thread/resume` + `turn/start`). Reports an absent socket (no daemon or ChatGPT Desktop private mode), unknown threads, threads owned by another client, and refuses server approval requests instead of approving them. Method names are pinned to Codex 0.154.0.

### Patch Changes

- 93cb28e: Parse global `gbot` flags only before the command so `gbot codex send` keeps `--json` / `--dir` inside the message; refuse native Windows for `gbot codex` with a clear error; strip terminal controls from thread listings; run unit tests through `scripts/run-unit-tests.mjs` so Windows and Node 18 work without shell globs.
- ef6ce79: Send the gateway bearer only to `https` hosts on `*.cursor.sh`, `*.cursor.com`, or `*.cursorvm.com`, and the EnsureSandBox / Cursor access token only to `*.cursor.sh` / `*.cursor.com`; refuse cross-origin fetch redirects; redact Authorization (any scheme), Cookie, and named token fields from error output. `GROK_BOT_ALLOW_LOCAL_GATEWAY=1` admits loopback gateways and `GROK_BOT_ALLOW_ANY_GATEWAY=1` disables the host check; both warn once on stderr.
- d59fa95: Add opt-in local JSONL thread history (`GROK_BOT_HISTORY=on`) with offline `gbot history` search.
- a7415d7: P1 bridge follow-ups: preserve send receipts with rejected/accepted/unknown delivery states (Codex `CodexSendError` keeps thread/turn IDs, gateway `sendPrompt` returns `delivery` + `messageId` and marks post-write loss unknown); bound the Codex WebSocket transport (idempotent close settling pending requests, socket destroy on every failure, exact handshake validation, fragmentation/UTF-8/opcode handling, header/frame/message/buffer budgets); make `gbot_thread` bounded without losing replies (truncation metadata, `full` bounded full-read in tool and `--full` in CLI, safe string normalization, 1–200 limit consistency, gateway deadline and response-byte cap).
- 9b034ce: Validate group membership in gateway mode before sending mutations: deduplicate member references, enforce one to six bot members, reject nested groups, and reject bots as group targets.
- ab70a00: Strip C0/C1 controls (including CR, backspace, and BEL) from `gbot codex list-threads` text output, not only ESC sequences.
- 93cb28e: Fix `gbot thread` so bot replies (`send-message` entries) show their text instead of empty lines, by sharing transcript parsing with the grok-bot plugin.
- 3fe1287: Use the signed-in Grok Bot app session on Windows (`%APPDATA%\\Grok Bot`, DPAPI Safe Storage).

## 0.2.3

### Patch Changes

- 5519136: Use the signed-in Grok Bot app session on Linux: read `~/.config/Grok Bot/gateway-descriptor.json` (honouring `XDG_CONFIG_HOME`), decrypt Chromium `v11` payloads with the Secret Service password via `secret-tool` and `v10` payloads with the basic-text key, and apply Linux's single PBKDF2 round instead of the macOS 1003.

## 0.2.2

### Patch Changes

- ce452cd: Support version 2 Grok Bot gateway descriptors and report unusable app sessions clearly in `gbot doctor`.

## 0.2.1

### Patch Changes

- 13f6858: Remove redundant group-member normalization branches.

## 0.2.0

### Minor Changes

- 9691ea3: Add complete bot and group profile creation and update fields, including instructions, titles, avatar shape and color, notifications, and sidebar visibility.
