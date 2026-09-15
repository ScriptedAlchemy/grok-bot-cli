# grok-bot-cli

## 0.2.3

### Patch Changes

- 5519136: Use the signed-in Grok Bot app session on Linux: read `~/.config/Grok Bot/gateway-descriptor.json` (honouring `XDG_CONFIG_HOME`), decrypt Chromium `v11` payloads with the Secret Service password via `secret-tool` and `v10` payloads with the basic-text key, and apply Linux's single PBKDF2 round instead of the macOS 1003.

## 0.2.2

### Patch Changes

- ce452cd: Support version 2 Grok Bot gateway descriptors and report unusable app sessions clearly in `gbot doctor`.

## 0.2.1

### Patch Changes

- 13f6858: Remove redundant group-member normalization branches.

## 0.2.0

### Minor Changes

- 9691ea3: Add complete bot and group profile creation and update fields, including instructions, titles, avatar shape and color, notifications, and sidebar visibility.
