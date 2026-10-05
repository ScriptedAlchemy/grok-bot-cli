---
"grok-bot-cli": patch
---

`gbot-install install grokbot` now sideloads gbot into the ScriptedAlchemy/plugins marketplace snapshot Grok Bot already syncs on its computer (plugin folder + marketplace.json entry + `plugins/cache/scriptedalchemy-plugins/gbot/<commit>/` with `.cache-complete`, the same layout as pstack), via agent-bundle 0bbc7c3. Re-running restores a pruned sideload; `GROK_BOT_SIDELOAD=0` disables it.
