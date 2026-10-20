# Copilot instructions — Lighthouse: Local Code Review

This repo's knowledge base lives in [`docs/`](../docs/README.md). Read it before making changes.

| Doc | Read it when you need to understand… |
|-----|--------------------------------------|
| [docs/README.md](../docs/README.md) | Product overview + 30-second orientation (start here) |
| [docs/architecture.md](../docs/architecture.md) | Module graph, the three views, the extension↔Copilot ownership split, the Ask-Copilot CLI bridge |
| [docs/data-model.md](../docs/data-model.md) | The on-disk `comments.json` v2 schema, v1 back-compat, durable `seqCounter` |
| [docs/engineering.md](../docs/engineering.md) | Build / package / deploy commands, VM verification, commit conventions |

Key invariants (see docs for detail):
- The extension **never calls a model/LM API** — AI work stays in the external Copilot CLI,
  through explicit Ask Copilot launches or the opt-in local MCP tools.
- Reviews are plain JSON under `.vscode/lighthouse-reviews/` — no DB or core-review server,
  and core review needs no network. Optional stdio MCP and explicit network actions are separate.
- Commit linear on `main` with the `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer; never commit the gitignored `.vsix`.

## Local development

Use commands from the repository root. The local tooling is Windows-first; it requires
Node.js/npm compatible with the locked dependencies, PowerShell, and the VS Code `code` CLI
for installation. VSCE is a local dev dependency, not a required global tool.

| Requested operation | Command |
| --- | --- |
| Set up a fresh checkout or restore changed dependencies | `npm ci` |
| Compile only | `npm run compile` |
| Prepare a new package version, then package | `npm run version:prepare`, then `npx @vscode/vsce package` |
| Build, package and install into local VS Code | `pwsh -File .\scripts\deploy-local.ps1` |
| Reinstall the existing package without rebuilding | `pwsh -File .\scripts\deploy-local.ps1 -InstallOnly` |
| Build/install and opt in to user-level `lighthouse-codereview` MCP | `pwsh -File .\scripts\setup-mcp.ps1` (use `-WhatIf` for a no-change preview) |
| Run regression tests | `npm test` |

The Windows CI workflow in `.github/workflows/ci.yml` runs `npm ci` and `npm test` using
Node 22 on pushes to `main` and pull requests. It has read-only repository permissions and no
publishing/deployment steps. Keep action references pinned to reviewed commit SHAs.

The deploy helper reads name/version from `package.json`, selects `<name>-<version>.vsix`,
and works independently of the caller's working directory when invoked by its full path.
After installation, use **Developer: Reload Window** in the target VS Code.
For debugging without installation, select **Run Extension** and press F5; the checked-in
launch configuration compiles first and opens an Extension Development Host.

Run only the requested operation: a build does not authorize installation, reload, or Git
changes. Do not reinstall dependencies as part of every local iteration. Do not stage,
commit, push or create branches/worktrees without explicit instruction.

## Versioning

Use calendar versions `YYYY.MMDD.revision`, with the middle component computed as
`month * 100 + day` (no leading zeros). For example, October 19's first build is
`2026.1019.1`; January 2's is `2026.102.1`.
Every **new build**, including a local build/install, must use the maintainer's current local
calendar date. Never reuse a previous day's version for a new local build.
`deploy-local.ps1` and the source-build path of `setup-mcp.ps1` run `npm run version:prepare`
**once**: a later date resets the revision to 1; another new build on the same date increments it.
The shared helper uses `npm version --no-git-tag-version --ignore-scripts` and updates the native
header. It does not stage, commit, tag, publish, or install dependencies.

Compile/tests never allocate versions. VSCE's prepublish hook runs `version:check` and compiles;
it rejects stale dates or inconsistent metadata without incrementing a second time.
For standalone packaging, run `npm run version:prepare` once before `npx @vscode/vsce package`.
Do not separately prepare before invoking a new-build script: that script already prepares.
Reinstalling an already-built artifact (`-InstallOnly`, `-VsixPath`, or `-UseInstalledExtension`)
does not allocate a version. That exception is not permission to rebuild changed source with
yesterday's version. Do not run new-build commands concurrently in the same checkout.

Keep `package.json`, the lockfile's top-level version and `packages[""].version` synchronized.
Also update the `lighthouse` Activity Bar container's title in `contributes.viewsContainers`
to `<displayName> (<version>)`, for example `Lighthouse: Local Code Review (2026.1019.1)`.
VS Code reads this as static text; it does not interpolate the manifest version.
Do not use version suffixes such as `-dev`; Marketplace prereleases use a numeric version
and the explicit `--pre-release` packaging/publishing flag. A version bump does not authorize
Git changes or publication. See [engineering.md](../docs/engineering.md#calendar-versioning)
for the version command and update-ordering rules.

## Review-file guidance versus contributor instructions

These instructions help develop Lighthouse itself. They are not installed into repositories
reviewed with Lighthouse. The tool-independent comment-file format is documented in
[`docs/data-model.md`](../docs/data-model.md); read it before editing review JSON.
The VSIX excludes `docs` and `.github`, so it does not ship these documents as an automatically
discoverable agent contract. The current Ask-Copilot bridge sends a short prompt and assumes
schema guidance is supplied separately; see the bridge's limitations in
[`docs/architecture.md`](../docs/architecture.md#7-the-ask-copilot-bridge-schema--agent-contract).