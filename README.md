# grok-bot-cli

CLI for [Grok Bot](https://cursor.com/help/grok-bot/plans) agents and groups: create, delete, membership, send, and read threads.

    gbot bots list
    gbot send Oncall status

There is no public HTTP API. This talks to the same box gateway the macOS app uses after EnsureSandBox. Use a Cursor session JWT, not a dashboard API key.

## Setup

Package: grok-bot-cli. Node 18+. Bins: gbot and grok-bot.

## Auth

Preferred: a Cursor session JWT in CURSOR_ACCESS_TOKEN.

    gbot bots list

Or set GROK_BOT_GATEWAY_URL plus GROK_BOT_GATEWAY_TOKEN and pass --gateway.

On a Grok Bot computer, SAND_GATEWAY_TOKEN and SAND_HOST_PORT are picked up automatically.

File fallback (local profile.json folders only; no send or thread):

    gbot --files --dir ./tmp-agents bots create --name Oncall

`--dir` is the local agents folder. `--root` is a thread message id.

## Commands

    gbot doctor
    gbot bots list
    gbot bots create --name NAME [--description TEXT] [--title TEXT]
    gbot bots get <id-or-name>
    gbot bots delete <id-or-name>

    gbot groups list
    gbot groups create --name NAME --member ID_OR_NAME [--member ...]
    gbot groups get <id-or-name>
    gbot groups members <id-or-name>
    gbot groups add <group> <bot>
    gbot groups remove <group> <bot>
    gbot groups set <group> --member ID [--member ...]
    gbot groups delete <id-or-name>

    gbot send <bot-or-group> <message...>
    gbot thread <bot-or-group> [--limit N] [--root MESSAGE_ID]
    gbot chat <bot-or-group>

Global flags: `--json` `--gateway` `--files` `--dir DIR`.

Groups follow the app: at least one member, no nesting, max 6.

## Examples

    gbot bots create --name Oncall --description pages
    gbot bots create --name Docs
    gbot groups create --name Launch --member Oncall --member Docs
    gbot send Oncall status?
    gbot send Launch standup
    gbot thread Oncall --limit 20
    gbot groups delete Launch
    gbot bots delete Oncall

## Gateway

The macOS app (com.anysphere.sand 0.20.0) calls:

    POST {gateway}/api/listAgents
    POST {gateway}/api/createAgent
    POST {gateway}/api/deleteAgent
    POST {gateway}/api/createGroup
    POST {gateway}/api/setGroupMembers
    POST {gateway}/api/sendPrompt
    POST {gateway}/api/getAgentTranscriptTail
    POST {gateway}/api/getAgentThread

A group is an agent plus group.json with version 1 and memberIds.

## License

MIT

