# Install gbot

Message Grok Bot from Codex, Claude Code, and Cursor, with managed automatic replies and explicit Codex conversation links.

Version: `0.9.1`

Run these commands from this bundle directory. The bundle is self-contained: every command below is
a host command or the bundled installer, and nothing requires the `agent-bundle` CLI. Where that CLI is
mentioned it is optional and automates the same steps.

## Claude Code

Claude Code installs this bundle through its local marketplace contract:

```sh
claude plugin marketplace add ./
claude plugin install gbot@gbot-marketplace --scope user
```

Replace `user` with `project` or `local` when that Claude scope is intended.

### Reinstall after a same-version rebuild

`claude plugin update` is version-gated: when the bundle content changed but `version` did not,
it reports the plugin is already at the latest version and leaves the cached copy stale.
Uninstall and install again instead (`--keep-data` preserves the plugin's persistent data):

```sh
claude plugin uninstall gbot@gbot-marketplace --scope user --keep-data
claude plugin marketplace add ./
claude plugin install gbot@gbot-marketplace --scope user
```

With the optional `agent-bundle` CLI, `agent-bundle install claude --from ./` runs this sequence
automatically when the installed copy has the same version but a different content hash; `--replace`
(alias `--force`) forces it.

### Uninstall

```sh
claude plugin uninstall gbot@gbot-marketplace --scope user --keep-data
```

Match the scope the plugin was installed with (`user`, `project`, or `local`). `--keep-data` keeps durable
runtime state (Claude orphans the cached copy, `state/` included, for its ~14-day grace period); omit it to
remove `~/.claude/plugins/data/<id>/` immediately.

The marketplace `gbot-marketplace` stays registered. Remove it only when nothing else installs from it:
`plugin marketplace remove` applies to every scope and every project, and `claude plugin list` shows only
the current project, so also check `~/.claude/plugins/installed_plugins.json` (under `$CLAUDE_CONFIG_DIR`
when set), where Claude records every scope of every install. The optional `agent-bundle uninstall claude`
below performs that inventory before it removes anything.

```sh
claude plugin marketplace remove gbot-marketplace
```

With the optional `agent-bundle` CLI, `agent-bundle uninstall claude --from ./ --plan` prints exactly what
would be removed and `agent-bundle uninstall claude --from ./` reverses the recorded registrations.
`agent-bundle install claude` records a receipt at `~/.claude/agent-bundle/receipts/gbot.gbot-marketplace.user.json`
(or under `$CLAUDE_CONFIG_DIR`; `user` is the install scope, pass `--scope project` or `--scope local` to match
a scoped install), and `uninstall` consumes it, running the two commands above in order and retaining the
marketplace while any other plugin, scope, or project still installs from it. Durable runtime state
is kept by default; `--purge-data --confirm-purge` removes `state/` and `~/.claude/plugins/data/<id>/`
immediately. A missing receipt or a cached copy that no longer matches it is refused unless `--force`; a
second run is a `not-installed` no-op.

## Codex

Codex installs this bundle from its local marketplace snapshot:

```sh
codex plugin marketplace add ./
codex plugin add gbot@gbot-marketplace
```

### Reinstall after a same-version rebuild

`codex plugin add` re-copies the marketplace snapshot and keeps plugin settings in `config.toml`.
`codex plugin remove` deletes that settings subtree, including nested MCP overrides, so a same-version
refresh is add-only:

```sh
codex plugin marketplace add ./
codex plugin add gbot@gbot-marketplace
```

Native add resets a plugin-level `enabled = false` to `true`.
The native plugin CLI has no qualified settings-preserving update API, so the optional
`agent-bundle install` refuses replacement when `plugin list --json` reports `enabled: false`
or omits `enabled` (`AB7004`) and leaves that install unchanged. Enable the plugin in Codex first, then rerun.

With the optional `agent-bundle` CLI, `agent-bundle install codex --from ./` runs this sequence
automatically when the installed copy has the same version but a different content hash; `--replace`
(alias `--force`) forces it.

### Uninstall

```sh
codex plugin remove gbot@gbot-marketplace
```

Codex 0.147.0 deletes the cached plugin tree, `state/` included, on `plugin remove` and has no keep-data
option.

The marketplace `gbot-marketplace` stays registered. Remove it only when nothing else installs from it:
`codex plugin list` shows every other plugin from it.

```sh
codex plugin marketplace remove gbot-marketplace
```

With the optional `agent-bundle` CLI, `agent-bundle uninstall codex --from ./ --plan` prints exactly what
would be removed and `agent-bundle uninstall codex --from ./` reverses the recorded registrations.
`agent-bundle install codex` records a receipt at `~/.codex/agent-bundle/receipts/gbot.gbot-marketplace.user.json` (or
under `$CODEX_HOME`), and `uninstall` consumes it, running the two commands above in order. `--keep-data`
cannot preserve durable state on Codex; the result says so (`unavailable`). A missing receipt or a cached
copy that no longer matches it is refused unless `--force`; a second run is a `not-installed` no-op.

## Cursor

Cursor has no non-interactive plugin install command. The bundled installer supports two delivery modes.

### Local plugin (default)

```sh
node ./install.mjs
```

It safe-copies the bundle to `~/.cursor/plugins/local/gbot`. Restart Cursor or run
`Developer: Reload Window` after installation. Cursor loads rules, skills, MCP servers, and the
manifest-declared `hooks/hooks.json` from that directory; plugin hooks run from the plugin root with
`${CURSOR_PLUGIN_ROOT}` substituted and need no `~/.cursor/hooks.json` entry.

### Reinstall after a same-version rebuild

The installer writes an install receipt (`.agent-bundle-install.json`: plugin, version, content hash,
owned files) beside the plugin manifest. Re-running `node ./install.mjs` on an identical artifact
is a no-op that says so. When the installed copy has the same version but different content, the
installer replaces its owned files in place and leaves runtime state (`state/`) untouched:

```sh
node ./install.mjs            # same-version content drift of a receipt-managed copy is replaced
node ./install.mjs --replace  # also replace a different installed version, or adopt a pre-receipt copy
```

`--force` is an alias for `--replace`. A directory that is not an agent-bundle install of this
plugin is always refused with an installed-versus-artifact content-hash comparison; remove it
manually. The optional `agent-bundle` CLI applies the same policy through
`agent-bundle install cursor --from ./ [--replace]`.

### Uninstall

```sh
node ./install.mjs --uninstall --plan                        # print exactly what would be removed
node ./install.mjs --uninstall                               # remove the receipt-owned files; keep state/
node ./install.mjs --uninstall --purge-data --confirm-purge  # also remove durable runtime state
node ./install.mjs --uninstall --mode marketplace            # remove a staged marketplace repository
```

Uninstall removes exactly what the receipt owns: the listed files, the directories the installer
created (including `~/.cursor/plugins/local` when the installer made it), and nothing else. Durable
runtime state under `state/` (state kernel, notices journal) — and, for an Agent Plugins pack with a stdio
server, the `~/.cursor/agent-bundle/plugin-data/<name>` directory the receipt records as `PLUGIN_DATA` — is kept
unless `--purge-data --confirm-purge` is passed (a kept data directory leaves a remnant receipt behind so a later
purge still finds it; an empty one is pruned); unowned files are left in place and listed. A supported older
receipt with no recorded state location retains the current environment's default as unproven; a keep-data run
cannot turn that observation into later purge authority. A directory without a receipt is refused unless
`--force` (which removes a pre-receipt legacy copy by its inventory); owned content that no longer matches
the receipt is refused unless `--force`; a directory that is not this plugin's install is always refused.
A second run is a `Not installed` no-op. With the optional `agent-bundle` CLI,
`agent-bundle uninstall cursor --from ./ [--mode marketplace]` applies the same policy, and
`agent-bundle doctor --from ./` shows the lifecycle stage (placed, registered, enabled, active) with
unobservable stages typed `unavailable`.

### Marketplace plugin

```sh
node ./install.mjs --mode marketplace
```

It stages a committed Git repository at `~/.cursor/agent-bundle/marketplaces/gbot` whose
`.cursor-plugin/marketplace.json` lists this plugin, then prints the exact Cursor step: Customize -> Plugins ->
"Add Plugins from Local Repository" -> select that directory -> Install. Cursor then shows the plugin as a
marketplace install (not "local") and manages it from Customize. `git` must be on PATH. Verify in Cursor:
Customize -> Plugins lists the plugin, and its files appear under `~/.cursor/plugins/cache`. The optional
`agent-bundle` CLI performs the same check with `agent-bundle doctor --host cursor`.

## Portable Agent Plugin

Portable is a distribution profile, not a host runtime with one universal install location.
This bundle follows the Agent Plugins open standard (Agent Plugins 1.0.0, https://agent-plugins.org).
Cursor loads this format natively from `~/.cursor/plugins/local/<name>`; restart Cursor or run
`Developer: Reload Window` after copying it. The bundled installer provides the Cursor local copy:

```sh
node ./install.mjs
```

### Other recorded clients

Each line below is pinned to that client's own documentation on the date shown, and names only the
paths this build actually wrote. Recognizing a document and running what it configures are separate:
`mcp` records that the client reads the emitted `mcp.json` as MCP configuration, while `placeholders`
records that it expands the reserved `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` and provides them to the
process it spawns. A client can do the first without the second, and then a plugin-relative server
is configured but not runnable there.

- **Antigravity** (docs retrieved 2026-09-06; no product or CLI version is published on any page) loads nothing from this bundle as published. Not loaded: manifest, skills, mcp, placeholders, hooks.
- **Cascade (Devin Desktop)** (docs.devin.ai/desktop retrieved 2026-09-06; Windsurf renamed to Devin Desktop, Cascade documented as the legacy agent beside the Devin Local agent) loads the components it recognizes without reading the manifest. Reads: `skills`. Install: `cp -R skills/<skill> .agents/skills/<skill>`. Not loaded: manifest, mcp, placeholders, hooks.
  - Partial `skills`: 2026-09-06: the emitted package root is not a Cascade discovery root; each skill directory is copied into .windsurf/skills/, ~/.codeium/windsurf/skills/, or .agents/skills/ before Cascade sees it, and the copy is what loads.
- **Cline** (@cline/cli 0.0.13 exercised 2026-09-06; docs.cline.bot retrieved 2026-09-06 (@cline/sdk 0.0.82)) loads the components it recognizes without reading the manifest. Reads: `skills`. Install: `cp -R skills/<skill> ~/.cline/skills/<skill>`. Not loaded: manifest, mcp, placeholders, hooks.
  - Partial `skills`: 2026-09-06: the skill tree must be copied into one of Cline's own roots; the emitted package is not a Cline install unit, and no CLI verb in @cline/cli 0.0.13 performs the copy.
- **CodeWhale** (Hmbown/CodeWhale main 19d34a5fb6c07b34e0b7234beb74a1cf1969efb4, docs retrieved 2026-09-06 (native Agent Plugins v1.0.0 support since v0.9.4)) loads this bundle as one plugin. Reads: `mcp.json`, `plugin.json`, `skills`. Install: `/plugin install ./<plugin directory>`. Not loaded: placeholders, hooks.
  - Partial `mcp`: 2026-09-06: CodeWhale narrows the standard at the plugin boundary. Its env rule — "Local stdio environment entries must use exact ${SOURCE_ENV} references" — rejects an emitted env value that is anything other than one whole variable reference. A remote server emitted into mcp.json is narrower still: the URL must be HTTPS (or explicit loopback HTTP) with no user information, query, or fragment, a literal header is rejected in favor of CodeWhale's own env_headers or bearer_token_env_var keys, redirects must stay on the reviewed origin, and the bundle must declare exactly the normalized endpoint host set in capabilities.network_hosts. That declaration rides in extensions["net.codewhale"], which this projection writes only when the author authors portable.extensions; a remote server emitted without it is a validation error, and "an active bundle must be … free of validation errors", so the whole bundle stays inactive there until the author declares the matching host set.
- **GitHub Copilot CLI** (@github/copilot 1.0.83, installed and exercised 2026-09-06) loads this bundle as one plugin. Reads: `plugin.json`, `skills`. Install: `copilot plugin install <plugin directory>`. Not loaded: hooks. This build also writes `.mcp.json`, which it uses for mcp instead. A root that also carries `.plugin/plugin.json` uses it for manifest and still reads the rest.
- **Devin CLI** (Agent Plugins 1.0.0; docs retrieved 2026-09-06, plugins documented as closed beta) loads this bundle as one plugin, but this build also writes `.claude-plugin/plugin.json`, which it reads as the plugin instead.
- **Gemini CLI** (@google/gemini-cli 0.58.0, installed and exercised 2026-09-06) loads the components it recognizes without reading the manifest. Reads: `skills`. Install: `gemini skills install <plugin directory>/skills/<skill>`. Not loaded: manifest, mcp, placeholders, hooks.
- **Grok Build** (xai-org/grok-build main 72a61251fcffb464bcc687aeb5a998e5a98ec0c9, docs retrieved 2026-09-06) loads the components it recognizes without reading the manifest. Reads: `skills`. Install from a marketplace (no local-directory install is verified for this artifact): `grok plugin install <marketplace plugin name> --trust`. Not loaded: manifest, mcp, placeholders, hooks.
- **Hermes Agent** (hermes-agent.nousresearch.com developer guide retrieved 2026-09-06; no version is printed on the page) loads this bundle as one plugin. Reads: `mcp.json`, `plugin.json`, `skills`. Install from a Git repository (no local-directory install is verified for this artifact): `hermes plugins install <owner>/<repository> --no-enable`. Not loaded: hooks.
  - Partial `manifest`: 2026-09-06: the validation rule set is not published: the page never states that the manifest root is treated as closed or what happens to an unknown root key.
  - Partial `placeholders`: 2026-09-06: the expansion sites are unpublished — the page does not say whether ${PLUGIN_ROOT} and ${PLUGIN_DATA} are expanded in args, env values, and cwd as §9.1 requires, only that the variables are provided.
- **JetBrains Junie** (junie.jetbrains.com/docs retrieved 2026-09-06, agent-skills page dated 01 September 2026; no CLI version is published on the page) loads the components it recognizes without reading the manifest. Reads: `skills`. Register: `junie --skill-location <plugin directory>/skills`. Not loaded: manifest, mcp, placeholders, hooks.
  - Partial `skills`: 2026-09-06: the emitted skills/ root is not a default location, so it loads only once registered with --skill-location or the skill-locations config field, and "if a project-level and a user-level skills have the same name, the user-level skill will be skipped".
- **Kiro (Powers)** (kiro.dev/docs/powers pages updated September 2, 2026 and August 4, 2026, retrieved 2026-09-06) loads this bundle as one plugin. Reads: `mcp.json`, `plugin.json`, `skills`. Install: `Powers panel -> Add Custom Power -> Import power from a folder -> select <plugin directory> -> Install`. Not loaded: placeholders, hooks.
  - Partial `manifest`: 2026-09-06: Kiro's "Required fields" table additionally requires version, description, author, and keywords, where the canonical schema requires only $schema and name — so a bundle that declares no portable author or keywords metadata does not meet Kiro's tightened manifest, and Kiro publishes no validation-error behavior to say what happens then.
  - Partial `mcp`: 2026-09-06: only stdio is documented for a power's mcp.json; no Kiro page states that a streamable-http server in that file is read, so an emitted remote server is unproven there.
- **OpenClaw** (Agent Plugins 1.0.0; docs retrieved 2026-09-06) loads this bundle as one plugin, but this build also writes `.claude-plugin/plugin.json`, which it reads as the plugin instead.
- **OpenCode** (opencode-ai 1.18.29 exercised 2026-09-06; opencode.ai/docs retrieved 2026-09-06) loads the components it recognizes without reading the manifest. Reads: `skills`. Install: `cp -R skills/<skill> .agents/skills/<skill>`. Not loaded: manifest, mcp, placeholders, hooks.
  - Partial `skills`: 2026-09-06: the skill tree must be copied into one of OpenCode's own roots; the emitted package as a whole is not an OpenCode install unit, and skill names must be unique across all roots ("Ensure skill names are unique across all locations").
- **Pi** (@mariozechner/pi-coding-agent 0.73.1 installed from npm 2026-09-07; packaged docs/skills.md and docs/packages.md read from that release) loads the components it recognizes without reading the manifest. Reads: `skills`. Register: `pi --skill <plugin directory>/skills`. Not loaded: manifest, mcp, placeholders, hooks.
  - Partial `skills`: 2026-09-07: the emitted skills/ root is not one of the scanned default roots, so it loads only when it is named with --skill or added to the `skills` settings array; discovery inside it is recursive once named.
- **Qoder CLI** (docs retrieved 2026-09-06; no CLI version is published on any page) loads the components it recognizes without reading the manifest. Reads: `skills`. Install: `qoder plugins install <plugin directory> --scope user`. Not loaded: manifest, placeholders, hooks. This build also writes `.mcp.json`, which it uses for mcp instead.
- **Swival** (docs retrieved 2026-09-06; no product version is published on the documentation pages) loads the components it recognizes without reading the manifest. Reads: `skills`. Register: `swival --skills-dir <plugin directory>/skills "<task>"`. Not loaded: manifest, mcp, placeholders, hooks.
  - Partial `skills`: 2026-09-06: the emitted skills/ root is not a default location, so it loads only once registered with --skills-dir or the swival.toml skills_dir field, and it loses by name to the default roots: "If the same skill name exists in multiple locations, the first one in the precedence order wins", with .swival/skills/ and .agents/skills/ ahead of --skills-dir paths. A registered tree outside the project resolves as external, which Swival adds "as read-only roots".
- **VS Code (Copilot agent plugins)** (code.visualstudio.com/docs/agent-customization/agent-plugins, page footer 9/2/2026, retrieved 2026-09-06) loads this bundle as one plugin. Reads: `mcp.json`, `plugin.json`, `skills`. Register: `"chat.pluginLocations": { "<plugin directory>": true }`. Not loaded: placeholders, hooks.
- **Zed Agent** (zed.dev/docs retrieved 2026-09-06; no page publishes a version or last-updated date) loads the components it recognizes without reading the manifest. Reads: `skills`. Install: `cp -R skills/<skill> ~/.agents/skills/<skill>`. Not loaded: manifest, mcp, placeholders, hooks.
  - Partial `skills`: 2026-09-06: only the skill folders load, one copy at a time, and the catalog is capped — "50KB catalog budget… Skills that don't fit are dropped from the catalog with a warning in the UI" — so a large emitted skill set is not guaranteed to be wholly visible.

### Cursor placeholder expansion

Cursor 3.18.25 spawns the stdio servers of an Agent Plugins package without expanding
`${PLUGIN_ROOT}` / `${PLUGIN_DATA}` in `args`, `env` values, or `cwd`, without providing the
reserved `PLUGIN_ROOT` / `PLUGIN_DATA` variables (spec §9.1), with an omitted `cwd` defaulting to
the home directory, and with plugin-relative `./` commands resolved against the workspace folder
(spec §7.2.1). The installer therefore rewrites `mcp.json` in the Cursor copy only: the plugin root
becomes `~/.cursor/plugins/local/<name>`, the data directory `~/.cursor/agent-bundle/plugin-data/<name>`
(created by the installer), an omitted `cwd` becomes the plugin root, `./` commands resolve against
it, and every stdio server gains `PLUGIN_ROOT` / `PLUGIN_DATA` in its environment. The bundle itself
stays spec-conformant; the pre-expansion document is kept in `.agent-bundle-install.json` (`cursorExpansion`),
and the optional `agent-bundle doctor --host cursor` verifies the expanded paths (`AB7326`). Nothing is changed for
other clients; the recorded clients above name which of them expand the placeholders themselves.

### Reinstall after a same-version rebuild

The installer records an install receipt (`.agent-bundle-install.json`) and replaces its owned files in
place when the same version was rebuilt with different content; runtime state (`state/`) is never
touched. Pass `--replace` (alias `--force`) to replace a different installed version or to adopt a
copy installed before receipts existed. Foreign directories are refused with a content-hash
comparison. For a client that manages its own copy, remove and re-add the plugin through that client
when only content changed at the same version.

### Uninstall

```sh
node ./install.mjs --uninstall --plan                        # print exactly what would be removed
node ./install.mjs --uninstall                               # remove the receipt-owned files; keep state/
node ./install.mjs --uninstall --purge-data --confirm-purge  # also remove durable runtime state
```

Uninstall removes exactly what the receipt owns (files, installer-created directories) and keeps
durable runtime state under `state/` (and the recorded `PLUGIN_DATA` directory of an Agent Plugins pack)
unless `--purge-data --confirm-purge` is passed. A missing
receipt or modified owned content is refused unless `--force`; foreign directories are always refused.
