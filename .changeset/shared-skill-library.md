---
"grok-bot-cli": minor
---

Add `gbot skills list|add|remove` for the account-wide Grok Bot skill library over the gateway (`getAgentWorkflows`, `importAgentWorkflowText`, `deleteAgentWorkflow`). Grok Bot has no per-bot skill attach: `add` makes a `SKILL.md` visible to every bot, `remove` deletes a `workflow` skill for every bot and refuses `managed`, `plugin`, and `automation` entries. Skills have no `--files` mode.
