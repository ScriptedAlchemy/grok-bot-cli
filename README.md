# grok-bot-cli

CLI for Grok Bot agents and groups: create, delete, membership, send, and read threads.

There is no public HTTP API. The macOS app (Grok Bot.app, `com.anysphere.sand` 0.20.0)
talks to a box JSON gateway after `EnsureSandBox`:

    POST {gateway}/api/createAgent
    POST {gateway}/api/deleteAgent
    POST {gateway}/api/createGroup
    POST {gateway}/api/setGroupMembers
    POST {gateway}/api/listAgents
    POST {gateway}/api/sendPrompt          # bot or group
    POST {gateway}/api/getAgentTranscriptTail
    POST {gateway}/api/getAgentThread

A group is an agent plus `group.json` `{ "version": 1, "memberIds": [...] }`.
Rules from the app: at least one member, no nested groups, max 6 members.

## Run

    cd /Volumes/bigssd/projects/grok-bot-cli
    node src/cli.js --help

Auth (live gateway, preferred):

    export CURSOR_ACCESS_TOKEN=...          # Cursor session JWT, not a dashboard API key
    # or, on the box:
    # SAND_GATEWAY_TOKEN + SAND_HOST_PORT are picked up automatically
    node src/cli.js --gateway bots list
    node src/cli.js send "CLI Test" "hello"
    node src/cli.js thread "CLI Test" --limit 20

File fallback (profile.json folders only; no send/thread):

    node src/cli.js --files --dir ./tmp-agents bots create --name Oncall

## Commands

    gbot doctor
    gbot bots list|create|get|delete
    gbot groups list|create|get|members|add|remove|set|delete
    gbot send <bot-or-group> <message...>
    gbot thread <bot-or-group> [--limit N] [--root MESSAGE_ID]

`--dir` selects a local agents folder. `--root` is reserved for a thread root message id.
