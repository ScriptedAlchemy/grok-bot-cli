---
"grok-bot-cli": patch
---

Reconnect from the active encrypted Grok Bot account when the cached gateway descriptor is absent, and send the installed app version (from the app's desktop-status.json, or the macOS app bundle) on backend requests so EnsureSandBox does not reject the CLI as an outdated client.
