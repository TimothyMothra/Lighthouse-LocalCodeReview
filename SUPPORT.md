# Support

Lighthouse is currently distributed from source or a locally built VSIX, not the Marketplace.
Report bugs or ask questions in [GitHub Issues](https://github.com/TimothyMothra/Lighthouse-LocalCodeReview/issues).

## Before reporting a problem

- **Lighthouse is disabled:** a trusted, disk-backed workspace is required. Restricted Mode and
  virtual workspaces intentionally disable the extension. Only grant trust after reviewing and
  trusting the repository itself; do not trust unfamiliar code merely to enable Lighthouse.
- **A local install still looks old:** use **Developer: Reload Window** in the intended VS Code
  window after installation. Check the installed version in Extensions or with
  `code --list-extensions --show-versions`.
- **No changed files or unexpected diffs:** open the intended Git folder, check Base/Compare and
  the effective-baseline tooltip, and use **Lighthouse: Refresh**. Baseline discovery uses refs
  already available locally; it does not automatically fetch. Saved files and unsaved editors
  have different reviewed-checkbox behavior.
- **Git cannot be found:** ensure Git is on the extension host's `PATH`. The review-store location
  assumes a single workspace folder; remote and multi-root support are not established claims.
- **Ask Copilot fails:** check that the CLI is installed, authenticated, and permitted to perform
  the requested actions. The current bridge assumes separately supplied schema guidance; see
  [AI tools and review files](README.md#ai-tools-and-review-files). Posting a local message does
  not require Copilot.

Do not delete review files or change Git state as a first troubleshooting step.

## Collect only the relevant diagnostics

Open **Output > Lighthouse** for error and action feedback. For startup/loading problems, use
**Lighthouse: Export Startup Diagnostics** and save the JSON outside the repository.
Note whether the capture followed a full launch or **Reload Window**, and which panes were open.

Performance and feature-usage logging are local and enabled by default, with no remote telemetry
upload. `lighthouse.perfLogging` and `lighthouse.usageLogging` control them independently.
The [startup diagnostics](docs/startup-diagnostics.md) and [usage guide](docs/usage-diagnostics.md)
describe the captured fields and partial-capture limitations.

Before sharing output, exports or screenshots, inspect and redact credentials, private paths,
repository/remote names, source or comment text, personal details and session identifiers.
Prefer a short relevant excerpt over an entire log. Do not upload a repository or review store.
Avoid posting sensitive security details in a public issue.

## Bug-report checklist

- Lighthouse version, VS Code version and Windows version.
- Source/F5 versus VSIX installation, and whether the affected window was reloaded.
- Workspace trust state, local versus remote/virtual, and single versus multi-root layout.
- Minimal steps to reproduce, expected result and actual result; use synthetic code/reviews
  wherever possible.
- Relevant settings, comparison mode and safe descriptions of the Git state, such as
  checked-out versus another source branch or saved versus unsaved edits.
- Exact error text and approximate occurrence time, with a small redacted diagnostic excerpt
  or screenshot if it helps explain the problem.

Back up `.vscode/lighthouse-reviews/` before manual repairs or identity migration. Reviews are
workspace files; uninstalling the extension does not automatically delete them.
