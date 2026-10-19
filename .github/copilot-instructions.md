# Copilot instructions — Lighthouse: Local Code Review

This repo's knowledge base lives in [`docs/`](../docs/README.md). Read it before making changes.

| Doc | Read it when you need to understand… |
|-----|--------------------------------------|
| [docs/README.md](../docs/README.md) | Product overview + 30-second orientation (start here) |
| [docs/architecture.md](../docs/architecture.md) | Module graph, the three views, the extension↔Copilot ownership split, the Ask-Copilot CLI bridge |
| [docs/data-model.md](../docs/data-model.md) | The on-disk `comments.json` v2 schema, v1 back-compat, durable `seqCounter` |
| [docs/engineering.md](../docs/engineering.md) | Build / package / deploy commands, VM verification, commit conventions |

Key invariants (see docs for detail):
- The extension **never calls a model/LM API** — all AI work is an external `copilot` CLI shell-out.
- Reviews are plain JSON under `.vscode/lighthouse-reviews/` — no server or DB, and core
  review workflows need no network. Explicit Copilot and Git network actions are separate.
- Commit linear on `main` with the `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer; never commit the gitignored `.vsix`.

## Local development

Use commands from the repository root. The local tooling is Windows-first; it requires
Node.js/npm compatible with the locked dependencies, PowerShell, and the VS Code `code` CLI
for installation. VSCE is a local dev dependency, not a required global tool.

| Requested operation | Command |
| --- | --- |
| Set up a fresh checkout or restore changed dependencies | `npm ci` |
| Compile only | `npm run compile` |
| Package only (also compiles through `vscode:prepublish`) | `npx @vscode/vsce package` |
| Build, package and install into local VS Code | `pwsh -File .\scripts\deploy-local.ps1` |
| Reinstall the existing package without rebuilding | `pwsh -File .\scripts\deploy-local.ps1 -InstallOnly` |
| Run regression tests | `npm test` |

The deploy helper reads name/version from `package.json`, selects `<name>-<version>.vsix`,
and works independently of the caller's working directory when invoked by its full path.
After installation, use **Developer: Reload Window** in the target VS Code.
For debugging without installation, select **Run Extension** and press F5; the checked-in
launch configuration compiles first and opens an Extension Development Host.

Run only the requested operation: a build does not authorize installation, reload, or Git
changes. Do not reinstall dependencies as part of every local iteration. Do not stage,
commit, push or create branches/worktrees without explicit instruction.

## Review-file guidance versus contributor instructions

These instructions help develop Lighthouse itself. They are not installed into repositories
reviewed with Lighthouse. The tool-independent comment-file format is documented in
[`docs/data-model.md`](../docs/data-model.md); read it before editing review JSON.
The VSIX excludes `docs` and `.github`, so it does not ship these documents as an automatically
discoverable agent contract. The current Ask-Copilot bridge sends a short prompt and assumes
schema guidance is supplied separately; see the bridge's limitations in
[`docs/architecture.md`](../docs/architecture.md#7-the-ask-copilot-bridge-schema--agent-contract).