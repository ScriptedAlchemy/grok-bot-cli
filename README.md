# grok-bot-cli

[![npm version](https://img.shields.io/npm/v/grok-bot-cli.svg)](https://www.npmjs.com/package/grok-bot-cli)

Manage [Grok Bot](https://cursor.com/help/grok-bot/plans) agents, groups, and messages from your terminal.

![Live create, group, send, and delete smoke test](https://raw.githubusercontent.com/ScriptedAlchemy/grok-bot-cli/main/demo/grok-bot-cli-demo.gif)

[Watch the MP4](https://github.com/ScriptedAlchemy/grok-bot-cli/blob/main/demo/grok-bot-cli-demo.mp4)

## Install

```sh
npm install --global grok-bot-cli
```

Requires Node.js 18+ and the Grok Bot desktop app on macOS, Linux, or Windows. Open Grok Bot and sign in once; `gbot` automatically uses the app's encrypted session and routing credentials. No token copying is required. On Linux the app keeps its session under `~/.config/Grok Bot` (or `$XDG_CONFIG_HOME`); when it is stored in the system keyring, `gbot` reads the key with `secret-tool` (package `libsecret-tools`). On Windows the session lives under `%APPDATA%\\Grok Bot` and decrypts with the app's DPAPI-wrapped Safe Storage key.

## Use

```sh
gbot bots list
gbot bots create --name Researcher
gbot bots update Researcher --description "Research the launch" --notify on
gbot bots create --name Writer
gbot groups create --name Launch --member Researcher --member Writer --description "Ship together"
gbot groups update Launch --title "Launch room" --hidden off
gbot send Researcher "Summarize the launch status."
gbot send Launch "Share your updates."
gbot thread Researcher
gbot thread Researcher --after <last-entry-id> --json
gbot groups delete Launch
gbot bots delete Researcher
gbot bots delete Writer
```

`update` fields: `--name` `--description`/`--instructions` `--title` `--avatar-shape` `--avatar-color` `--notify` `--hidden`. `--description` is the UI Instructions field.

`gbot thread --after ID` filters the bounded tail locally and returns entries strictly
after that opaque entry ID. Its JSON includes `cursor`, `entryCount`, and `gapReset`.
An unchanged poll has `entryCount: 0`; an unknown or expired ID returns one bounded
snapshot with `gapReset: true`. The gateway request remains limit-only.

Run `gbot --help` for every command.

## Gateway URL policy

By default `gbot` only sends credentials to expected hosts:

- **Gateway** URLs (box + API): `https` on `*.cursor.sh` / `*.cursor.com` / `*.cursorvm.com` (the box family EnsureSandBox returns).
- **Backend** URLs (`EnsureSandBox` / `CURSOR_API_BASE_URL`): `https` on `*.cursor.sh` / `*.cursor.com` only — never `*.cursorvm.com`, so a Cursor access token cannot be pointed at a box host.

- `GROK_BOT_ALLOW_LOCAL_GATEWAY=1` — permit `http(s)://127.0.0.1`, `localhost`, and `::1` for **gateways** only (local/dev). Prints a one-shot stderr warning.
- `GROK_BOT_ALLOW_ANY_GATEWAY=1` — disable host checks (unsafe; for break-glass only). Prints a one-shot stderr warning.

All gateway / `EnsureSandBox` fetches use `redirect: "error"` so credentials are not followed across redirects.

## Messaging Codex threads from Grok Bot

`gbot codex` attaches to a local [Codex app-server](https://learn.chatgpt.com/docs/app-server) daemon and injects messages into its threads with the documented JSON-RPC methods (`initialize`, `thread/list`, `thread/resume`, `turn/start`).

```sh
codex app-server daemon start          # once per machine session
gbot codex status                      # socket, daemon version, reachability
gbot codex list-threads --limit 10     # id, status, cwd, preview
gbot codex send <threadId> "Grok here: the build is green, please continue."
```

`send` resumes the thread, starts a turn with your text, prints the turn id, and returns; Codex keeps working after `gbot` disconnects. Every command accepts `--json`.

**Which Codex you reach.** `gbot` connects to `$CODEX_HOME/app-server-control/app-server-control.sock` (default `~/.codex/...`) with a built-in WebSocket client. The daemon must be started by `codex app-server daemon start`. `list-threads` shows the threads recorded under `CODEX_HOME` (CLI, TUI, VS Code); `send` works on any of them that no other client currently holds open. Method and parameter names are pinned to the Codex release recorded in `src/codex-bridge.js` (`codex app-server generate-json-schema`); `status` prints the daemon and CLI versions so a stale daemon is visible, and `codex app-server daemon restart` picks up the installed CLI. Native Windows is not supported yet (AF_UNIX control socket); use WSL, Linux, or macOS.

**ChatGPT Desktop limitation.** Desktop runs its own private stdio app-server and does not publish the shared control socket, so external clients cannot reach live Desktop tasks. When the socket is absent, `gbot codex status` exits 1 and says so, naming the upstream issues: [openai/codex#41014](https://github.com/openai/codex/issues/41014) and [openai/codex#41112](https://github.com/openai/codex/issues/41112). `gbot` never reads Desktop's temporary `CODEX_APP_TOOLS_PIPE_PATH` sockets under `/tmp/codex-browser-use/`; that channel is private to Desktop.

**Failure modes.**

- Socket absent: no daemon, or Desktop-private mode. Start the daemon or wait for the upstream fixes.
- Unknown thread: `send` fails with "Unknown Codex thread"; use `list-threads`.
- Thread open elsewhere: a thread with an active writer (VS Code, TUI) fails with "open in another client"; close it there first.
- Approvals: `gbot` never approves commands or file changes on your behalf. If Codex asks while `gbot` is still connected, `send` refuses the request, exits 1, and tells you the turn id. `send` disconnects as soon as the turn starts, so later approval requests stay with the daemon for a Codex client to answer; for unattended sends set `approval_policy = "never"` in the daemon's `config.toml`.

## Talking to Grok Bot from Codex

`plugin/` is an [Agent Bundle](https://scriptedalchemy.github.io/agent-bundle/) plugin
that gives Codex, Claude Code, and Cursor two MCP tools on a `grok-bot` server,
`gbot_send` and `gbot_thread`, plus a `talk-to-grok-bot` skill that tells the agent
when to ping a bot and how to word the message. The tools bundle this repository's
gateway client, so the installed plugin does not need `gbot` on `PATH`.

The plugin is not part of the npm package. From a clone of this repository, build
the artifact once, then install it into each host you use:

```sh
git clone https://github.com/ScriptedAlchemy/grok-bot-cli.git
cd grok-bot-cli/plugin
npm install
npm run build
npx agent-bundle install codex --from artifact
npx agent-bundle install claude --from artifact
npx agent-bundle install cursor --from artifact
npx agent-bundle doctor --from artifact
```

Add `--replace` to an install command to overwrite an earlier copy. `npm run check`
runs the plugin gates: source validation, build, artifact validation, typecheck, and
the route-unit tests, which drive both tools against a loopback fake gateway.

`gbot_thread` returns a small receipt by default: deterministic `summary`, opaque
`cursor`, `entryCount`, and `gapReset`.
Pass the cursor back as `after` for an exclusive client-side delta. Pass `full:true`
only when bounded entry bodies are needed in structured content; `Agent.Text` remains
the short summary. Unknown cursors set `gapReset: true`; repeat that call with
`full:true` to inspect the bounded reset snapshot.

Auth resolves exactly as for `gbot`: `GROK_BOT_GATEWAY_URL` + `GROK_BOT_GATEWAY_TOKEN`,
then the Grok Bot app session, then `CURSOR_ACCESS_TOKEN`. The MCP server therefore
needs outbound HTTPS to the gateway host and read access to the app-session file
(`~/.config/Grok Bot` on Linux, `~/Library/Application Support/Grok Bot` on macOS).
A sandbox that blocks network egress or hides the home directory makes `gbot_send`
fail with the gateway error; run `gbot doctor` inside the same sandbox to see which
credential source is visible.

To route a repository's agents to a bot by default, add a note to its `AGENTS.md`:

```md
## Grok Bot

Use the `grok-bot` MCP tools to coordinate with Grok Bot. Send questions and
handoffs to the `General` bot with `gbot_send` (first line: who you are and what
you need), then read the reply with `gbot_thread`. Do not block a turn waiting
for it.
```

## Local history

Recording is **opt-in**. Set `GROK_BOT_HISTORY=on` (or `true`/`1`) to append successful
`send`/`thread`/`chat` observations as plaintext JSONL at
`~/.grok-bot-cli/history.jsonl`. Without that env, nothing is written.

```bash
export GROK_BOT_HISTORY=on
gbot send Researcher "Investigate the startup timeout"
gbot thread Researcher
gbot history Researcher --search timeout
gbot history --path
```

`history` works offline. Use `--history-dir` / `GROK_BOT_HISTORY_DIR` to relocate,
`--no-history` to skip one command. New dirs are `0700`, files `0600`. Conversation
text is recorded as you typed it; gateway credentials and raw response metadata are not.

## License

MIT
