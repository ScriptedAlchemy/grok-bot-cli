# grok-bot-cli

## 0.8.0

### Minor Changes

- e5b5c87: Expose cross-host MCP messaging tools: hide Codex tools in Codex and Grok tools in truthfully identified Grok Bot clients, while retaining shared bridge controls.

## 0.7.0

### Minor Changes

- 8dd8d3d: Forward pending Grok auto-review and local-tool approval cards as Codex notices without treating chat replies as authorization. Add CLI and MCP commands to inspect requests and explicitly accept once or decline an exact current request.

### Patch Changes

- a31df6f: Allow automatic messaging to establish a checkpoint over older bot outputs without run IDs while continuing to reject new outputs without correlation IDs.
- 27966e6: Pin the Agent Bundle compiler and runtime to the same immutable preview commit so rebuilds do not depend on mutable pull-request tarballs.
- f2b08fb: Tighten Desktop private-stdio detection so probe-shell cmdlines that only mention ChatGPT.app + app-server + codex-app-tools no longer false-positive; keep the Resources/codex path match.
- 1e68988: Isolate relay workers by their desktop keyring environment so headless MCP callers cannot replace the authenticated worker used by desktop CLI callers.

## 0.6.0

### Minor Changes

- 0f86d73: Add Codex conversation tools to generated plugins and MCP: bounded thread discovery, guarded sends, completion waits, and event watching. Add CLI wait/watch and send --wait while preserving immediate send receipts.
- ae51078: Add managed Grok/Codex conversation delivery with native Codex reply routing, explicit durable links, scoped operator responses, background worker lifecycle controls, and packaged foreground service entry. Preserve manual sends when native identity is unavailable and distinguish accepted submissions from execution and return delivery.

## 0.5.0

### Minor Changes

- aeb5ebf: Use `gbot thread`, `GROK_BOT_GATEWAY_URL` with `GROK_BOT_GATEWAY_TOKEN`,
  `CURSOR_ACCESS_TOKEN`, `CURSOR_API_BASE_URL`, `GROK_BOT_AGENTS_DIR`, and `entries`
  transcript containers; remove the `chat` alias, the `GROK_BOT_ACCESS_TOKEN` and
  `SAND_ACCESS_TOKEN`, `SAND_BACKEND_URL`, `SAND_HOST_GATEWAY_*`, `SAND_GATEWAY_TOKEN`,
  `SAND_HOST_PORT`, `SAND_AGENTS_DIR`, and `SAND_DATA_ROOT` compatibility variables,
  implicit localhost gateway routing, and fallback transcript and entry-id shapes (#69).

## 0.4.5

### Patch Changes

- f7fbeea: Report Desktop shim configuration separately from attachment evidence. `gbot codex status` now includes `desktopShimConfigured` and no longer emits `attached-shim` merely because the wrapper is installed and selected. Preserve observed private-stdio processes and report managed attachment as unverified, including when the daemon is unreachable.
- 5395aa7: Refuse every non-loopback gateway or backend URL when `GROK_BOT_TEST=1` or `NODE_ENV=test`, ignoring `GROK_BOT_ALLOW_ANY_GATEWAY`, so the test suites can never send a prompt to a live thread. The unit and route-unit runners set `GROK_BOT_TEST=1`.

## 0.4.4

### Patch Changes

- 4563466: Report `attached-shim` from `gbot codex status` when the desktop-shim is active (installed wrapper that the Desktop-facing `CODEX_CLI_PATH` points at), outranking a stale-looking private-stdio process list.

## 0.4.3

### Patch Changes

- 53cfbee: Stack the must-fix set from the Codex reject of the Act-On-PR bridge and the unfinished follow-up accept bar: commit stdout BEFORE writing (dirty stdout never exits 1 / never fail-opens to stock Codex) with bounded stdout writes and termination, keep healthy idle reads untimed (separate absolute handshake/first-RPC deadline from mid-session write/lock budgets), clear the init timer only on the matching initialize response/error (notifications never satisfy it), stay silent on foreign serverRequest approvals (deferring turn-scoped ones until the turn id is known), require strict HTTP/1.1 101 plus accept, flush EOF-tail data before the WS Close, and keep the wrapper hardening (self-fallback refusal, bridge+python3+preflight gating, uninstall reporting, Linux status wording with shell-quoted path).

## 0.4.2

### Patch Changes

- f874c4e: Add `gbot codex desktop-shim install|uninstall|status`: installs a fail-open `CODEX_CLI_PATH` wrapper plus stdio-to-WebSocket bridge under `~/.codex/bin/` so ChatGPT Desktop shares the managed Codex app-server daemon (stock `app-server proxy` hangs for Desktop stdio). The wrapper preflights the socket and runs the bridge as a fallible child (no daemon start on the hot path), exports the `CODEX_HOME`-derived socket, the bridge handshake and first RPC run under absolute deadlines with accept validation and continuation assembly, the stdin commit point is byte-precise, `status` reads the macOS GUI-domain env, and `send` no longer answers another client's approvals outside its own turn. macOS persists the GUI env via LaunchAgent; uninstall restores stock Desktop/Codex behavior.

## 0.4.1

### Patch Changes

- 409e5c8: Update the development Node.js type definitions to v24. (#51)

## 0.4.0

### Minor Changes

- 1dc6d34: Ship `gbot` as one generated Agent Bundle CLI at the package root and add `gbot-install install|uninstall <cursor|codex|claude>` / `gbot-install doctor` for the bundled `grok-bot` MCP tools and `talk-to-grok-bot` skill; delete the nested `plugin/` project and the hand-written dispatcher. Breaking (pre-1.0): Node.js 22.19.0 or newer is required; options are command-local (`gbot send --history-dir DIR …`, no leading globals); `--json` is reserved anywhere before `--`, so put `--` before flag-like message text; `send` and every `codex` command write one JSON document to stdout with `exitCode` (failures keep `error`, `delivery`, `reason`, `mode` and exit 1), other commands print failures on stderr and exit 1; argument and schema errors exit 2; `--instructions` is gone (use `--description`) and `--notify`/`--hidden` take `on|off` only; `chat` records history rows as `event: "thread"`; the installed bundle is named `gbot` (uninstall an earlier source-built `grok-bot` plugin first). (#50)

### Patch Changes

- 4b3cd78: Make `gbot codex` dependable for automation and safe for agent relays: `codex status --json` reports `socketState`, a stable failure `mode` (`socket-absent`, `permission-denied`, `not-a-socket`, `connect-failed`, `handshake-failed`, `bad-response`, `windows-unsupported`), `schema.compatibility` separate from reachability, a bounded `codex --version` probe (`cliVersionProbe`), and `desktopAttached: "unknown"`; `codex list-threads` adds `--cursor`, bounds `--limit` to 1–200, rejects unknown arguments, validates the response shape, and strips terminal controls from every text field in JSON too. `codex send` and `send` accept `--correlation-id`, `--reply-to`, `--hop`, and `--envelope`, return receipts with `messageId` (sent as Codex's `clientUserMessageId`), `correlationId`, `replyTo`, `hop`, and `maxHops`, refuse relays at `GROK_BOT_MAX_HOPS` (default 4) with `reason: "hop-limit"`, honor the operator allowlist `GROK_BOT_CODEX_THREADS`, refuse `active` threads with `reason: "busy"` instead of steering a running turn (or, with `--when-busy queue` and `GROK_BOT_CODEX_EXPERIMENTAL=1`, hand them to Codex's experimental `thread/queue/add` and report `delivery: "queued"`; `codex queue <threadId>` lists that queue), and emit `reason`/`mode` in every `--json` send failure. Fixes #37, #38, #39.
- bf64783: Add `gbot thread --after ID` for exclusive client-side filtering of the bounded gateway tail, including no-op cursors and explicit gap-reset snapshots.

## 0.3.1

### Patch Changes

- HOLD-fix follow-up for the P1 bridge work: gateway reads count true bytes through a streaming reader that cancels on overflow; Codex transport uses an absolute handshake deadline, caps terminated headers and complete frames before decoding, guarantees socket destruction on close, and routes malformed RPC through failure handling; CLI `--json` failures emit structured errors with delivery and IDs; sends stay `unknown` without a confirmed receipt; MCP full reads add aggregate budgets with truncation metadata and a CLI continuation path.

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
