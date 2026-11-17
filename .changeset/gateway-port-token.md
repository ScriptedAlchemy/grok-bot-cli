---
"grok-bot-cli": patch
---

Send the gateway port token. Since mid-November 2026 the box load balancer answers every gateway call with 404 "The request could not be routed" unless it carries `x-anyrun-port-token`. EnsureSandBox returns the token as `gatewayPortToken`, and the Grok Bot app (1.1) sends it on every gateway request; the CLI now does the same.
