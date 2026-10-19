# Engineering

How to build, package, deploy, and verify Lighthouse: Local Code Review. Commands run from the
repository root; no particular checkout path is required.

## 1. Prerequisites

- **Node.js/npm** compatible with the locked development tooling; prefer a maintained Node LTS.
  The lockfile includes tooling requiring at least Node 20.18.1. `@types/node` is a declaration
  package, not a Node runtime pin.
- **VS Code** (the manifest declares `engines.vscode ^1.85.0`; minimum-version verification is
  still release-readiness work).
- **PowerShell** for `scripts\deploy-local.ps1` (requires 5.1+, examples use `pwsh`).
- **`code` CLI** on `PATH` for local installation. The helper also checks the standard
  `C:\Program Files\Microsoft VS Code\bin\code.cmd` location.
- **`@vscode/vsce`** for packaging (a dev dependency; no global install needed).
- **git** on `PATH`.

The conversation page uses `markdown-it` at runtime for safe Markdown formatting. It is loaded
lazily, not on the startup critical path. VSCE includes production dependencies; do not exclude
all of `node_modules` from the VSIX.

Node.js/npm and VSCE are development/package tools, not separate prerequisites for using an
already-built VSIX. Core review does not require Copilot; Ask Copilot separately requires the
installed, authenticated CLI, appropriate tool permissions, and schema guidance.

## 2. Layout

| Path | Contents |
|------|----------|
| `src/` | TypeScript sources (see the module graph in `architecture.md`) |
| `out/` | Compiled `*.js` (gitignored build output; what VS Code actually runs) |
| `scripts/deploy-local.ps1` | Package + sideload into the host VS Code |
| `scripts/comparison.test.cjs` | Git ancestry, automatic-target, comparison-state, and webview regression tests |
| `scripts/reviewed-files.test.cjs` | Saved-content checklist invalidation, dirty-checkbox UX and guarded-write regressions |
| `scripts/metadata-cache.test.cjs` | Lazy branch-local cache persistence, bounds, isolation and atomic-write/fallback regressions |
| `docs/` | This knowledge base |
| `package.json` | Manifest: commands, views, menus, configuration, activation |
| `tsconfig.json` | TS config (target/module, `out/` outDir) |

## 3. Build / package / deploy

### Normal local-development loop

```powershell
npm ci                                  # first checkout, or after dependency changes
pwsh -File .\scripts\deploy-local.ps1     # build + package + install
# Then: Developer: Reload Window in the target VS Code
```

For subsequent source edits, rerun only the deploy command. The helper uses the manifest's
`name` and `version` to select `<name>-<version>.vsix`; do not edit it for every version bump.
It resolves the repository relative to its own script location, so a full script path works
from another working directory.

Reinstall the existing artifact without compiling or packaging:

```powershell
pwsh -File .\scripts\deploy-local.ps1 -InstallOnly
```

For debugging without modifying the installed extension, choose **Run Extension** and press F5.
`.vscode\launch.json` runs the `npm: compile` task and opens an Extension Development Host.

### Individual operations

These are alternatives for the requested operation, not extra prerequisites before deploying:

```powershell
npm run compile                 # TypeScript -> out/ only
npx @vscode/vsce package         # compile via vscode:prepublish, then package only
npm test                        # when requested: compile + Node regression suites
```

- **Never commit `*.vsix`** — these are gitignored build outputs.
- Local installation uses `code --install-extension ... --force`; it does not publish to the
  Marketplace. A build/package request alone does not authorize installation or reload.
- Installing a VSIX is not proof that the target window is running it. Reload that window to
  pick up the build.

To confirm the install:

```powershell
code --list-extensions --show-versions | Select-String lighthouse
# Compare the reported timothymothra.lighthouse version with package.json.
```

### Calendar versioning

The extension uses `YYYY.MMDD.revision`: the year, a numeric `month * 100 + day`, and a
revision starting at 1 for each new calendar date. For example:

| Build date / revision | Extension version |
| --- | --- |
| October 19, 2026, first build | `2026.1019.1` |
| October 19, 2026, second build | `2026.1019.2` |
| October 20, 2026, first build | `2026.1020.1` |
| January 2, 2027, first build | `2027.102.1` |

Numeric components cannot have leading zeros. Use the maintainer's local calendar date when
manually assigning a version. A new distributable build needs a new version; local rebuilds may
reuse the current version. Compile, package and deploy commands do not change it automatically.
Do not backdate releases or reuse published versions: each new publication must be greater than
the previous version.

When a version change is requested, synchronize the manifest and both root lockfile version
fields without creating a commit/tag or running version lifecycle scripts:

```powershell
npm version <YYYY.MMDD.revision> --no-git-tag-version --ignore-scripts
```

Then update the title of the `lighthouse` Activity Bar container in
`package.json` under `contributes.viewsContainers.activitybar` to
`<displayName> (<version>)`, currently `Lighthouse: Local Code Review (2026.1019.1)`.
This is the native header above Comparison, not the Comparison pane's own name.
VS Code reads a static string here; version placeholders are not expanded automatically.
Keep the extension ID and Marketplace display name unchanged when updating only this header.

VS Code Marketplace requires three numeric components; neither `2026.10.19.1` nor a suffix such
as `2026.1019.1-dev` is the publishing format. Use `--pre-release` explicitly when requested
to package/publish a pre-release; the calendar version alone does not select that channel.
Preview and stable builds need distinct versions. VS Code can move a pre-release user to a
higher stable version, so order versions across both channels deliberately.

The deploy helper automatically selects `lighthouse-<version>.vsix`. After a version bump,
build/package the new artifact before using `-InstallOnly`; an older VSIX still contains its
older manifest version and must not just be renamed.

### Comparison regression tests

Run `npm test` to compile and execute the built-in Node test runner. The baseline regression suite
is `scripts/comparison.test.cjs`; the real-Git/embedded-tree suite is `scripts/comparison-ui.test.cjs`.
The tests construct disposable Git object databases and run read-only Git queries against them:
stacked branches, tracking aliases, ambiguous tips, moved targets, merges, detached sources, bounded
discovery, and pagination to the root. VS Code boundaries are stubbed to exercise explicit base
pinning, source-following, lazy review paths, provider messages, and the shipped webview script.
Tests also cover compact row rendering, History/Review mode transitions, native context-menu
payload/scoping, file expansion, keyboard focus, and collapse-all. Lazy-loading assertions require
zero commit-page requests and zero rendered rows before first expansion, cached reopening without
duplicate requests (including empty/in-flight results), and deferred invalidation while collapsed.
Native VS Code menu presentation
still requires an extension-host or manual UI check; a DOM test alone does not exercise the host.
No test stages, commits, or changes branches in the developer's repository.

## 4. Manifest highlights (`package.json`)

- `publisher`: `TimothyMothra`; `repository.url`:
  `https://github.com/TimothyMothra/Lighthouse-LocalCodeReview.git`.
- `activationEvents`: `onStartupFinished` plus
  `workspaceContains:.vscode/lighthouse-reviews/**/comments.json`.
- `capabilities.untrustedWorkspaces.supported`: `true` (works in Restricted Mode).
- **~40 commands** and three views under the `lighthouse` container; commit rows are inside Comparison.
- Comparison title-bar order: `collapseAllCommits@0` · `copyCompareBranch@1` · `copyComparePath@2` · `openTerminal@3` ·
  `refreshAll@4`.

### Configuration keys

| Key | Default | Purpose |
|-----|---------|---------|
| `lighthouse.tags` | `[idea, question, bug, change, todo, nit, praise]` | `/tag` autocomplete set |
| `lighthouse.copilotPath` | `"copilot"` | CLI invoked by Ask-Copilot |
| `lighthouse.copilotArgs` | `["-p"]` | args prepended before the prompt |
| `lighthouse.defaultRemote` | — | preferred remote for branch listing |
| `lighthouse.autoCreateOnEmpty` | — | auto-create a review when none exists |
| `lighthouse.perfLogging` | — | verbose `[perf]` timings to the OUTPUT channel |
| `lighthouse.usageLogging` | `true` | local `[usage]` actions/exposure summaries; no remote telemetry |
| `lighthouse.deferThreadsOnLoad` | — | defer CommentController render for faster first paint |

## 5. Performance notes

- **Fast-return activation.** `activate()` does no awaited git work; shared comparison initialization
  is requested by panes, comparison commands or new discussions. See `architecture.md` §5.
  Subprocess waits and shared extension-host stalls can consume seconds; local timings cannot
  attribute that delay to antivirus or a particular extension.
- **Bounded startup metadata.** Root/watch paths are batched; one watched-generation HEAD/ref
  snapshot feeds target discovery and baseline resolution. Worktree-only notifications do not
  repeat ancestry. Ref/configuration changes and explicit Refresh retain fresh resolution.
- **No-shell git helpers ("KB-001").** `git.ts` uses `child_process` with an argv array (no shell),
  e.g. `listWorktreesCli` / `gitv`, to avoid flashing shell windows and reduce spawn overhead on the
  hot path.
- **Memoized comparison.** `changedFiles` / `logRange` results are cached keyed by the effective
  baseline/compare commit pair, so changing an upstream or pin invalidates the right results.
- Turn on `lighthouse.perfLogging` and watch the **Lighthouse** OUTPUT channel to see `[perf]`
  structured timings. **Lighthouse: Export Startup Diagnostics** saves the bounded trace,
  milestones, aggregates and outstanding operations to JSON. See
  [Startup diagnostics](startup-diagnostics.md) for the capture protocol and interpretation.

## 6. VM verification (Hyperloop)

Behavioral verification is done in an isolated Windows Sandbox VM (`wsb-test`) so a flaky first
comment or a stale-branch update can be exercised end-to-end without touching the host.

- **Harness:** `$hl = "$env:LOCALAPPDATA\Hyperloop\bin\hyperloop.exe"`. `copy-file … tovm` the
  `.vsix`, install into an **isolated** `--user-data-dir` / `--extensions-dir`, launch (Escape past
  Welcome/Sign-in), then drive via keyboard verbs.
- **git in the VM** is on `PATH` via `C:\lighthouse\tools\git\cmd` for newly provisioned harnesses.
- **Keyboard verbs:** `hotkey --combo Ctrl+Shift+P` (key combos) and
  `type --hwnd <h> --text/--keys` (text / SendKeys). Note: `press-keys` / `type-text` are **not**
  valid verbs.
- **Screen capture:** use `PrintWindow(hwnd, hdc, 2)`. GDI `CopyFromScreen` is permanently frozen in
  a disconnected console session; `PrintWindow` bypasses the compositor and produces live captures.

## 7. Commit conventions

- **Linear history on `main`.** No merges, no feature-branch PRs for routine work.
- Every commit carries the trailer:
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- **Never** stage or commit `*.vsix` (gitignored).
- No push / PR without explicit instruction.

## 8. Dependencies & pins

| Package | Version | Why |
|---------|---------|-----|
| `@types/node` | `^20.11` | development Node API declarations, not a runtime pin |
| `@types/vscode` | `^1.85` | declaration range; the lockfile can resolve newer APIs than the declared engine floor |
| `@vscode/vsce` | `^3.9.2` | packaging |
| `typescript` | `^5.4` | compiler |

Production dependencies for the conversation renderer ship with the compiled `out/`; dev-only
tooling and TypeScript declarations used solely for development are not runtime requirements.

## 10. Comparison regression coverage

`npm test` compiles and runs `scripts/comparison.test.cjs` and `scripts/diagnostics.test.cjs` with
Node's built-in test runner, plus `usage.test.cjs` and `usage-integration.test.cjs`.
Diagnostic tests cover span correlation, failures, bounded retention,
logging controls, pane readiness and the webview acknowledgement protocol.
Comparison tests also cover branch-query coalescing, namespace batching, catalog invalidation,
cross-repository isolation, path normalization and stale-state suppression.
Usage tests cover privacy filtering, action counts versus exposure, focused-time accounting,
editor classification, early inline discussions and shared on-demand comparison initialization.
`conversation.test.cjs` covers full transcript rendering, deleted/uncommitted-file independence,
live reply updates, legacy identity, workspace-scoped references and separate Read/Code actions.
`review-discovery.test.cjs` covers targeted multi-root/nested scans, absent stores, permission
failures, in-flight sharing and linked-directory cycle avoidance. Branch tests cover large
unambiguous catalogs, batched shortening exceptions and older Git capability fallback.
`pane-defaults.test.cjs` covers pane order/collapse contributions, toolbar removal, initial Files
expansion without repeated refresh overrides, and the persisted resolved-thread visibility toggle.
`conversation-page.test.cjs` covers review-wide topics, safe Markdown, lazy first persistence,
queued/guarded updates, explicit Copilot launch, deleted-code independence and draft/reference restoration.
The read-only Git-query fixtures cover advancing/stale target refs, rebases, stacked targets,
explicit remote selection, ambiguous ancestry, pin persistence/reset/invalidation, and consistent
baseline endpoints across file lists, commits and diff editors. They do not modify any Git refs,
index, or working-tree files. No extension host or additional test dependency is required.
Startup regressions additionally cover attached/detached/unborn CLI HEAD reads, nested and linked
worktree watch paths, in-flight HEAD-query isolation/retry, snapshot expiry, API hydration versus
real HEAD/ref/upstream changes, and trailing refreshes for changes during initialization/resolution.
Comparison tests also require no placeholder-root queries, root-ready rather than baseline-ready
release, cancelled disposed/superseded requests, visible initialization errors with retry, and
model HEAD reuse without weakening explicit live branch refresh.

`reviewed-files.test.cjs` covers two-sided fingerprints, legacy-check reset, saved-only invalidation,
staging/commit and baseline identity, hidden/deleted files, binary and literal-path Git reads,
dirty-editor disabling, stale work, shared review-write guards and explicit failures. Operation-count
assertions require no saved hashes for unsaved typing, unchecked paths, comment-only refreshes or
unchanged metadata hints, and one hash for coalesced same-path save/filesystem bursts. The shipped
Files client is executed to check both checkbox variants and availability-only updates. Run the
focused suite with `npm run compile` followed by
`node --test scripts\reviewed-files.test.cjs`; `npm test` includes it automatically.
Native disabled-control presentation and actual VS Code event delivery still need an isolated
extension-host smoke check when desktop automation is available.

`metadata-cache.test.cjs` covers reload hits, exact commit/path keys, explicit absence, comparison/
repository isolation, strict format rejection, four-commit/4-MiB bounds, write cleanup and failure
fallback, concurrent misses/eviction, and diagnostic privacy. Reader integration verifies that disk
metadata does not suppress current saved-byte verification or add eager startup lookups.
`npm test` discovers the suite automatically; no dependency, ignore-file, or Git-state changes
are required.

## 9. Known constraints

- Windows-first development tooling: `deploy-local.ps1` and the VM harness are PowerShell.
  Cross-platform and remote/virtual-workspace support have not been established by a release matrix.
- The Ask-Copilot round-trip depends on the `copilot` CLI being installed and on the personal
  instruction guidance that teaches the agent to read `.vscode/lighthouse-reviews/`. The source
  schema is in `docs\data-model.md`, but `docs` and contributor `.github` instructions are excluded
  from the VSIX; no complete agent instruction document is bundled or installed into reviewed repos.
- Single workspace folder is assumed for the review store.
