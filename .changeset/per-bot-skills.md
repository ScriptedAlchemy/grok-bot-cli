---
"grok-bot-cli": minor
---

Add `gbot skills list|add|remove <bot>` to attach a `SKILL.md` to one Grok Bot over the gateway (`getAgentWorkflows`, `importAgentWorkflowText`, `deleteAgentWorkflow`). `add` posts to that bot only; `remove` refuses plugin and team-managed skills. Skills have no `--files` mode.
