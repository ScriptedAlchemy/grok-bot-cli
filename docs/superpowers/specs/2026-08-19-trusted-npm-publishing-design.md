# Trusted npm Publishing Design

## Goal

Publish `grok-bot-cli` from GitHub Actions without a long-lived npm token, attach npm provenance automatically, and prove that the resulting registry package installs and runs on macOS. Prepare—but do not submit—an X post sharing the repository.

## Release contract

- A published GitHub Release is the only automatic publish trigger.
- The release tag must be exactly `v` plus the version in `package.json`.
- Publishing runs on a GitHub-hosted Ubuntu runner with Node 24 and the latest npm CLI.
- The job has only `contents: read` and `id-token: write` permissions.
- The workflow contains no `NODE_AUTH_TOKEN` and stores no npm publishing secret.
- npm trusts only `ScriptedAlchemy/grok-bot-cli` and the exact workflow filename `publish.yml` for `npm publish`.
- npm's trusted-publisher path generates provenance automatically.

## Repository changes

Add `.github/workflows/publish.yml` with these gates:

1. Check out the release commit.
2. Install Node 24 and update npm to the latest release.
3. Verify the release tag matches `package.json`.
4. Run `npm test`.
5. Build and inspect the npm tarball.
6. Install the tarball into an isolated prefix and run `gbot --help` through the generated executable.
7. Run `npm publish --access public` using OIDC.
8. Poll the registry for the exact released version and install it into a fresh prefix for a post-publish `gbot --help` smoke.

Add the exact public repository URL to `package.json`. Add a small script for the packed-artifact smoke only if shell inlining would obscure the workflow.

## npm configuration

After `publish.yml` exists on GitHub, create the trusted publisher with the current npm CLI:

- Package: `grok-bot-cli`
- Provider: GitHub Actions
- Repository: `ScriptedAlchemy/grok-bot-cli`
- Workflow file: `publish.yml`
- Allowed action: `npm publish`

If npm requests interactive 2FA, pause and request the OTP from the user. Verify the saved relationship with `npm trust list grok-bot-cli` before releasing.

## First trusted release

Bump to `0.1.1`, commit and push the workflow and metadata, create tag and GitHub Release `v0.1.1`, then watch the publish job to completion. Do not call a green workflow sufficient: verify npm reports `0.1.1`, install that exact version globally on the Mac, run `gbot --help`, and run a live read-only `gbot bots list` using automatic Grok Bot app authentication.

## Failure handling

- A version/tag mismatch fails before publication.
- Test, package, or installed-bin failures fail before publication.
- Missing or mismatched npm trust fails at `npm publish`; no token fallback is configured.
- Registry propagation is retried for a bounded period after publish.
- If the release workflow fails after the version is published, do not reuse that version; fix forward with a new patch version.

## X draft

Open X in the user's existing Chrome session, attach the repository demo GIF, and draft concise copy containing the install command and repository URL. Do not click Post or schedule the post. Leave the composer open for user review.

## Verification

- GitHub workflow syntax passes `actionlint`.
- Local tests and Gitleaks pass before commit.
- Trusted publisher configuration is listed by npm.
- GitHub Actions publish job succeeds from the release.
- npm registry metadata and a fresh macOS global install both report `0.1.1`.
- The live CLI can list bots without manually supplied auth variables.
- X composer contains the intended copy and GIF, with no submission performed.
