---
"grok-bot-cli": minor
---

Scaffold ChatGPT Desktop CDP adapter and MCP/CLI tools (`chatgpt_desktop_*`). List/search keep separate `host` (`all`|`local`|id/name) and `modelProvider`→`modelProviders` filters. `chatgpt_desktop_list_hosts` / `gbot chatgpt-desktop hosts` discovers hosts from `remote-thread-summaries-v3` (+ optional app-server remote-env method) and modelProviders via app-server list method or distinct `thread/list`. Reports `hostsSource` / `modelProvidersSource`. Remote read returns typed error with host hint. Fixes `modelProviders: []` on list-threads. Reports `backend`.
