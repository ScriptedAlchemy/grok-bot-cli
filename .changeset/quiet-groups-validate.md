---
"grok-bot-cli": patch
---

Validate group membership in gateway mode before sending mutations: deduplicate member references, enforce one to six bot members, reject nested groups, and reject bots as group targets.
