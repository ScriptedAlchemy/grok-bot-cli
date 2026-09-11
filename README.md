# grok-bot-cli

[![npm version](https://img.shields.io/npm/v/grok-bot-cli.svg)](https://www.npmjs.com/package/grok-bot-cli)

Manage [Grok Bot](https://cursor.com/help/grok-bot/plans) agents, groups, and messages from your terminal.

![Live create, group, send, and delete smoke test](https://raw.githubusercontent.com/ScriptedAlchemy/grok-bot-cli/main/demo/grok-bot-cli-demo.gif)

[Watch the MP4](https://github.com/ScriptedAlchemy/grok-bot-cli/blob/main/demo/grok-bot-cli-demo.mp4)

## Install

```sh
npm install --global grok-bot-cli
```

Requires Node.js 18+ and the Grok Bot desktop app on macOS or Linux. Open Grok Bot and sign in once; `gbot` automatically uses the app's encrypted session and routing credentials. No token copying is required. On Linux the app keeps its session under `~/.config/Grok Bot` (or `$XDG_CONFIG_HOME`); when it is stored in the system keyring, `gbot` reads the key with `secret-tool` (package `libsecret-tools`).

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
printf %s 'Exact UTF-8 message' | gbot send Researcher --stdin
gbot thread Researcher
gbot --json thread Researcher --normalized --limit 50
gbot groups delete Launch
gbot bots delete Researcher
gbot bots delete Writer
```

`update` fields: `--name` `--description`/`--instructions` `--title` `--avatar-shape` `--avatar-color` `--notify` `--hidden`. `--description` is the UI Instructions field.

Run `gbot --help` for every command.

Use `send <target> --stdin` when the message must not appear in the process
argument list. Standard input is preserved exactly and must be valid UTF-8,
non-empty, free of NUL bytes and surrounding whitespace, and no larger than
64 KiB. Do not combine `--stdin` with a positional message. In particular, use
`printf %s` rather than `echo` when an extra trailing newline is not intended.

For integrations that need a stable transcript shape, combine `--normalized`
with `--json thread` or `--json chat`. It returns only the target identity and
messages with `id`, explicit `user`/`assistant`/`unknown` role, and text. Without
`--normalized`, JSON output remains the original gateway response.

## Gateway failures and readback

Gateway requests have a 15-second deadline that includes reading the response body.
Requests are not retried automatically, and redirects are rejected. Errors report
the method and status without including server response bodies or credentials.

A send timeout, network failure, HTTP 408 or 5xx, or an invalid/empty success
response can leave delivery unknown. Do not resend automatically: read the target
thread and verify the original message in the Grok Bot app first. A new CLI send
uses a new client nonce, so invoking it again is not a deduplicated retry.

The gateway module accepts an optional positive `timeoutMs` in the final options
argument of `ensureSandbox` and `gatewayCall`. The CLI uses the 15-second default.

Plain-text transcript output handles both direct content and nested
`message.content` / `message.text`. Use `--json` when the full structured result is
needed. These integrations depend on the signed-in app and its internal gateway;
revalidate reads and one controlled send after app or service changes.

## License

MIT
