# Lighthouse: Local Code Review

A **local-only VS Code extension** for reviewing your own git branch diffs the way you'd review a
pull request — native inline comment threads, a three-view "PR panel", `/tag` classification, and a
one-click **Ask Copilot** round-trip, with every comment stored as plain JSON on disk.
Core review workflows work offline; optional Copilot and explicit Git network actions can use
the network.

> **Status:** local-only, single-developer tool. The extension **never calls a language model
> directly** — all AI work happens through an external `copilot` CLI shell-out. Reviews live under
> `.vscode/lighthouse-reviews/` (no review server or database), a superset of — and never a
> clobber of — the original `Gururagavendra.local-pr-review` format.

## Screenshot

![Lighthouse: Local Code Review showing Comparison, Changed Files, Threads, and a synthetic inline review](docs/images/screenshot.png)

_Current three-view layout with Commits embedded in Comparison, captured using only synthetic
widget-service code and review comments — see [`DEMO.md`](./DEMO.md)._

## What it does

- **Three-view review panel** in a dedicated Activity Bar container, all driven by one in-memory
  *active comparison* (`base` = target branch or commit, `compare` = source branch under review):
  - **Comparison** — inline `Base` / `Compare` selectors above a collapsed **Commits** section,
    loaded on first expansion and cached for reopening. **History** walks source ancestors;
    **Review** shows `git log base..compare`. Right-click any
    commit and choose **Set as Base** to pin its SHA, **Copy Commit SHA**, or **Open Commit Diff**.
    **↶ Unpin** beside Base returns to automatic branch/shared-ancestor selection.
  - **Changed Files** — a hierarchical folder tree of changes from the effective baseline to the
    source, with per-file reviewed checkboxes; click opens a native diff. The default cumulative
    mode includes saved working-tree and untracked changes when the source is checked out.
  - **Threads** — inline and review-wide discussions for the active review. Code-linked rows
    navigate to code; **Read** opens the complete discussion, and **New Thread** starts a
    review-wide discussion without a code location.
- **Native inline comment threads** — comments render as first-class VS Code `CommentController`
  threads in the editor gutter, with reply, resolve / unresolve, and copy commands.
- **`/tag` classification** — type `/` in any comment box for autocomplete over the tag set; tags
  are merged into the thread on submit.
- **Ask Copilot round-trip** — hand a review thread to the `copilot` CLI; when the agent writes its
  reply back into `comments.json`, a file watcher reloads and re-renders it in-thread. The extension
  only ever *shells out* — it never calls a model itself.
- **Plain-JSON storage** — reviews are human-readable JSON under `.vscode/lighthouse-reviews/`,
  created lazily on first mutation so clean repos stay clean. Durable thread ids and v1/v2
  back-compat are preserved on every write.

## Quick start

The extension is not on the Marketplace yet. Build and install into your local VS Code from
source. Local development is Windows-first and requires Node.js/npm compatible with the locked
tooling, PowerShell (`pwsh` for the commands below), and the **`code` CLI** on `PATH`.

```powershell
# From the repo root, set up dependencies once (or after dependency changes).
npm ci

# Build, package and install into local VS Code.
pwsh -File .\scripts\deploy-local.ps1
```

For later source edits, rerun only the deploy command, then use **Developer: Reload Window** in
VS Code. The helper reads the package name/version from `package.json`; no script edit is needed
after a version change. To reinstall the existing VSIX without rebuilding:

```powershell
pwsh -File .\scripts\deploy-local.ps1 -InstallOnly
```

For debugging without installation, select **Run Extension** in VS Code and press F5. The
checked-in launch configuration compiles and opens an Extension Development Host.
See [engineering.md](./docs/engineering.md) for compile-only, package-only and test commands.

Core review requires VS Code and Git on `PATH`; it does not require Copilot or a separate
Node.js installation when using an already-built VSIX. Ask Copilot additionally requires an
installed, authenticated `copilot` CLI and the permissions needed for the requested actions.
The review-store location assumes a single workspace folder; other platforms and remote/virtual
workspaces are not established support claims.

## AI tools and review files

The tool-independent [comment-file schema](./docs/data-model.md) documents how to read
`.vscode/lighthouse-reviews/**/comments.json`, including v1/v2 compatibility, replies, authors
and durable thread IDs. Supply that documentation explicitly to another AI tool before asking
it to edit reviews.

The current VSIX does **not** bundle a complete AI instruction document or install instructions
into a reviewed repository. Ask Copilot sends a short schema hint and assumes additional schema
guidance is supplied separately. The repo's
[Copilot instructions](./.github/copilot-instructions.md) are for developing Lighthouse itself,
not an agent contract distributed to extension users.

Performance and feature-usage logging are local and enabled by default; there is no remote
telemetry upload. See [startup diagnostics](./docs/startup-diagnostics.md) and
[local feature usage](./docs/usage-diagnostics.md) for collected fields, export behavior and the
`lighthouse.perfLogging` / `lighthouse.usageLogging` settings.

## Tags

Classify a thread by typing `/` in the comment box and picking from the autocomplete:

`/idea` · `/question` · `/bug` · `/change` · `/todo`

(The full configurable set also includes `/nit` and `/praise`; edit `lighthouse.tags` to customize.)

## Documentation

Full knowledge base in [`docs/`](./docs/README.md):

- [architecture.md](./docs/architecture.md) — ownership split, the three views, the
  `CommentController`, and the Ask-Copilot bridge.
- [data-model.md](./docs/data-model.md) — on-disk layout, the v2 schema, v1 back-compat, the tag set,
  and the durable `seqCounter`.
- [engineering.md](./docs/engineering.md) — build / package / deploy commands, VM verification, and
  commit conventions.

See [`DEMO.md`](./DEMO.md) for the repeatable demo path and how to capture the screenshot above.

## License

[MIT](./LICENSE)
