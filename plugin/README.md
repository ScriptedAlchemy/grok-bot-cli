# grok-bot plugin

The Agent Bundle plugin half of [`grok-bot-cli`](https://github.com/ScriptedAlchemy/grok-bot-cli): the
`grok-bot` MCP server (`gbot_send`, `gbot_thread`) and the `talk-to-grok-bot` Skill for Codex, Claude Code,
and Cursor.

It is not published on its own. `agent-bundle prepack` emits `dist/`, and the `grok-bot-cli` tarball ships
that directory together with the `gbot-install` bin:

```sh
npm install --global grok-bot-cli
gbot-install install cursor      # or claude / codex; --replace upgrades an older copy
gbot-install doctor
```

Develop with `npm ci && npm run check` in this directory (Node 22.19+).
