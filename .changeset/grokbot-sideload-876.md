---
"grok-bot-cli": patch
---

`gbot-install install grokbot` uses agent-bundle 0.4.0 (bf98f04, agent-bundle #876): the sideload reuses Grok Bot's existing `scriptedalchemy/plugins` marketplace clone commit, adds gbot to that clone's `marketplace.json`, writes `plugins/cache/scriptedalchemy-plugins/gbot/<commit>/` with `.cache-complete`, and records every written path in the install receipt so `uninstall grokbot` removes exactly those paths. `--json` output carries a `sideload` field. Retarget or disable it with `--sideload-repo`, `--sideload-slug`, `--no-sideload` (or `GROK_BOT_SIDELOAD_REPO`, `GROK_BOT_SIDELOAD_SLUG`, `GROK_BOT_SIDELOAD=0`; `GROK_BOT_AGENT_DATA_DIR` and `GROK_BOT_HOME` locate Grok Bot's data). `GROK_BOT_SIDELOAD_MARKETPLACE` must now name a single repository. The next install retires the 0.12.3 sideload record, and `gbot-install doctor --host grokbot` reports the sideload state as `AB7335`.
