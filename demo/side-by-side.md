# Side-by-side

Without the routing header, `POST /api/listAgents` returns 404.

With `x-anyrun-network-token` on the same request, the gateway returns 200 and the CLI can create, group, send, and delete.

The CLI now sends EnsureSandBox headers and `GROK_BOT_GATEWAY_HEADERS` on every `/api/*` call.


Recorded 2026-08-19 PT: create two bots, create group, send to bot and group, delete group and bots. All 200.
