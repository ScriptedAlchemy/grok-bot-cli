# Trusted npm Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `grok-bot-cli@0.1.1` from a GitHub Release through npm trusted publishing, verify the registry-installed CLI, and prepare an unsubmitted X draft.

**Architecture:** A single GitHub-hosted release workflow validates version/tag identity, tests and smoke-installs the packed artifact, then lets npm exchange GitHub's OIDC token for a short-lived publish credential. npm binds trust to the public repository and exact workflow filename, so no npm token is stored in GitHub. After publication, the workflow and the Mac both verify the exact registry version.

**Tech Stack:** Node.js 24, npm 11.15+, GitHub Actions, npm trusted publishing/OIDC, npm provenance, actionlint, Chrome/X.

**Spec:** `docs/superpowers/specs/2026-08-19-trusted-npm-publishing-design.md`

## Global Constraints

- Use GitHub-hosted `ubuntu-latest`; self-hosted runners are not supported by npm trusted publishing.
- Grant only `contents: read` and `id-token: write` to the publish job.
- Store no npm publish token and set no `NODE_AUTH_TOKEN` for publication.
- Bind npm trust to `ScriptedAlchemy/grok-bot-cli` and `publish.yml`, allowing only `npm publish`.
- A release tag must equal `v${package.json version}`.
- Do not post or schedule the X draft.

---

### Task 1: Package release identity

**Files:**
- Modify: `package.json`
- Create: `test/release-config.test.js`

**Interfaces:**
- Consumes: public repository `https://github.com/ScriptedAlchemy/grok-bot-cli.git`
- Produces: `package.json.repository`, `package.json.homepage`, and `package.json.bugs` metadata used by npm provenance and package consumers.

- [ ] **Step 1: Write the failing metadata test**

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

test("publishing metadata points at the public GitHub source", () => {
  assert.deepEqual(pkg.repository, {
    type: "git",
    url: "git+https://github.com/ScriptedAlchemy/grok-bot-cli.git",
  });
  assert.equal(pkg.homepage, "https://github.com/ScriptedAlchemy/grok-bot-cli#readme");
  assert.deepEqual(pkg.bugs, {
    url: "https://github.com/ScriptedAlchemy/grok-bot-cli/issues",
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/release-config.test.js`

Expected: FAIL because `repository`, `homepage`, and `bugs` are absent.

- [ ] **Step 3: Add the exact public source metadata**

Add to `package.json`:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/ScriptedAlchemy/grok-bot-cli.git"
},
"homepage": "https://github.com/ScriptedAlchemy/grok-bot-cli#readme",
"bugs": {
  "url": "https://github.com/ScriptedAlchemy/grok-bot-cli/issues"
}
```

- [ ] **Step 4: Run the focused and full suites**

Run: `node --test test/release-config.test.js && npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit the package identity slice**

```bash
git add package.json test/release-config.test.js
git commit -m "Add npm release metadata"
```

### Task 2: OIDC release workflow

**Files:**
- Create: `.github/workflows/publish.yml`

**Interfaces:**
- Consumes: GitHub Release tag, `package.json` version, npm OIDC environment.
- Produces: a tested `npm publish --access public` invocation with automatic provenance.

- [ ] **Step 1: Create the release workflow**

```yaml
name: Publish to npm

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"
          package-manager-cache: false

      - name: Update npm for trusted publishing
        run: npm install --global npm@latest

      - name: Verify release version
        shell: bash
        run: |
          package_version=$(node -p "require('./package.json').version")
          test "$GITHUB_REF_NAME" = "v$package_version"

      - name: Test
        run: npm test

      - name: Pack and smoke-test the executable
        shell: bash
        run: |
          package_file=$(npm pack --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)[0].filename))")
          install_root=$(mktemp -d)
          npm install --global --prefix "$install_root" "./$package_file"
          "$install_root/bin/gbot" --help

      - name: Publish with npm trusted publishing
        run: npm publish --access public

      - name: Verify registry publication
        shell: bash
        run: |
          package_version=$(node -p "require('./package.json').version")
          for attempt in {1..12}; do
            if test "$(npm view grok-bot-cli@"$package_version" version 2>/dev/null)" = "$package_version"; then
              exit 0
            fi
            sleep 5
          done
          exit 1
```

- [ ] **Step 2: Validate workflow syntax**

Run: `actionlint .github/workflows/publish.yml`

Expected: exit 0 with no findings.

- [ ] **Step 3: Run repository security and package checks**

Run: `npm test && npm pack --dry-run --json >/dev/null && gitleaks dir --redact --no-banner .`

Expected: all commands exit 0 and Gitleaks reports no leaks.

- [ ] **Step 4: Commit and push the workflow**

```bash
git add .github/workflows/publish.yml
git commit -m "Publish npm releases with OIDC"
git push origin main
```

### Task 3: Configure npm trusted publishing

**Files:**
- No repository files.

**Interfaces:**
- Consumes: npm package ownership, GitHub repository, pushed `publish.yml`.
- Produces: npm trust relationship authorizing only `npm publish` from the named workflow.

- [ ] **Step 1: Confirm compatible local tooling and npm identity**

Run: `node --version && npm --version && npm whoami`

Expected: Node ≥22.14, npm ≥11.15, user `zackljackson`.

- [ ] **Step 2: Inspect existing trust state**

Run: `npm trust list grok-bot-cli`

Expected: either no configuration or the exact desired GitHub configuration.

- [ ] **Step 3: Create the trust relationship when absent**

Run:

```bash
npm trust github grok-bot-cli \
  --repo ScriptedAlchemy/grok-bot-cli \
  --file publish.yml \
  --allow-publish \
  --yes
```

If npm opens or requests 2FA, complete the browser authorization; request an OTP from the user only when npm explicitly prompts for one.

- [ ] **Step 4: Verify exact trust claims**

Run: `npm trust list grok-bot-cli --json`

Expected: GitHub repository `ScriptedAlchemy/grok-bot-cli`, workflow `publish.yml`, publish allowed, stage publish not allowed.

### Task 4: First OIDC release and registry install proof

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: trusted publisher and release workflow.
- Produces: npm `grok-bot-cli@0.1.1` plus GitHub Release `v0.1.1`.

- [ ] **Step 1: Bump the package version without creating a tag**

Run: `npm version 0.1.1 --no-git-tag-version`

Expected: `package.json` reports `0.1.1`.

- [ ] **Step 2: Re-run release gates**

Run: `npm test && actionlint .github/workflows/publish.yml && npm pack --dry-run --json >/dev/null && gitleaks dir --redact --no-banner .`

Expected: all commands exit 0.

- [ ] **Step 3: Commit and push the version**

```bash
git add package.json
git commit -m "Release 0.1.1"
git push origin main
```

- [ ] **Step 4: Create the GitHub Release**

Run:

```bash
gh release create v0.1.1 \
  --repo ScriptedAlchemy/grok-bot-cli \
  --target main \
  --title "grok-bot-cli v0.1.1" \
  --generate-notes
```

Expected: public release URL and a new `Publish to npm` workflow run.

- [ ] **Step 5: Watch the exact workflow**

Run:

```bash
run_id=$(gh run list --workflow publish.yml --event release --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$run_id" --exit-status
```

Expected: the publish job succeeds, including its registry verification step.

- [ ] **Step 6: Install the exact registry version globally on the Mac**

Run:

```bash
npm install --global grok-bot-cli@0.1.1
gbot --help
env -u CURSOR_ACCESS_TOKEN -u GROK_BOT_GATEWAY_URL -u GROK_BOT_GATEWAY_TOKEN gbot --json bots list
```

Expected: the executable prints help and the live read-only roster without manually supplied auth variables.

- [ ] **Step 7: Verify npm provenance and signatures**

Run: `npm view grok-bot-cli@0.1.1 version dist.integrity repository --json`

Expected: version `0.1.1`, integrity present, and repository metadata points at `ScriptedAlchemy/grok-bot-cli`. Confirm the npm package page displays provenance.

### Task 5: Prepare the X draft

**Files:**
- Read: `demo/grok-bot-cli-demo.gif`

**Interfaces:**
- Consumes: verified npm `0.1.1`, public GitHub repository, demo GIF.
- Produces: an unsubmitted X composer draft.

- [ ] **Step 1: Open X in the existing Chrome session**

Navigate to `https://x.com/compose/post` without submitting anything.

- [ ] **Step 2: Enter the final copy**

```text
Just shipped grok-bot-cli: create and manage Grok Bot agents and groups from your terminal, send prompts, and inspect threads. It uses your signed-in Grok Bot session automatically—no token copying.

npm i -g grok-bot-cli
https://github.com/ScriptedAlchemy/grok-bot-cli
```

- [ ] **Step 3: Attach the real demo GIF**

Attach `demo/grok-bot-cli-demo.gif` and wait for the upload preview to finish.

- [ ] **Step 4: Verify draft state without posting**

Confirm the composer contains the exact copy, repository URL, and GIF; confirm the Post button was not pressed. Leave Chrome on the composer for user review.
