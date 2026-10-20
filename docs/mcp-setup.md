# Set up Lighthouse MCP locally

The MCP server's name is **`lighthouse-codereview`**. Setup is user-level and applies to new
Copilot CLI sessions in any local repository/worktree. It does not add repository configuration,
submit model prompts, or enable automatic feedback processing.
The VS Code extension ID and `.vscode/lighthouse-reviews` storage directory are unchanged.

## Recommended: automated setup

Prerequisites: Windows PowerShell 5.1+ or PowerShell 7, **Node.js 22+**, Git, Copilot CLI, and
local desktop VS Code with its `code` command available. The script does not install these
applications or override trust, disabled-server settings, or organization MCP policy.

From the Lighthouse source checkout:

```powershell
# Optional: preview without building, installing, registering, or creating temporary files.
pwsh -File .\scripts\setup-mcp.ps1 -WhatIf

# Confirm the one user-level setup operation when prompted.
pwsh -File .\scripts\setup-mcp.ps1
```

The script:

1. Checks the required commands and Node version.
2. Restores locked build dependencies with `npm ci` only when required build modules are missing.
3. Prepares today's calendar build version once, then packages through VSCE's checking/compile hook.
4. Validates package identity and extracts only the bundled setup/server assets.
5. Installs the VSIX through VS Code's CLI and checks its reported installed version before
   executing any bundled JavaScript.
6. Checks registration ownership and potential name collisions before changing MCP configuration.
7. Registers `lighthouse-codereview` with the same implementation used by the GUI command.
8. Starts the installed payload through a separate stdio MCP connection, checks its identity
   and all four tools, and makes a **read-only** `list_reviews` request.
9. Removes its temporary staging files and reports any remaining manual steps.

If you explicitly approve unattended execution, suppress the confirmation:

```powershell
pwsh -File .\scripts\setup-mcp.ps1 -Confirm:$false
```

Source builds prepare `YYYY.MMDD.revision` automatically: the first on a later date uses revision 1,
and another new build on that date increments it. Metadata is synchronized before packaging;
VSCE checks it without another increment. The script does not commit, tag, or publish anything.
Existing VSIX/installed-extension modes do not allocate a new version. See
[calendar versioning](engineering.md#calendar-versioning).

### Use an existing VSIX

Skip dependency restore and packaging:

```powershell
pwsh -File .\scripts\setup-mcp.ps1 -VsixPath 'C:\Downloads\lighthouse.vsix'
```

The package must include the new `out/mcp/setup.cjs` helper and report the
`lighthouse-codereview` identity. Older packages from before this rename must be rebuilt;
editing the registered name alone does not update their payload.

### Use an already-installed extension

For example, after a future Marketplace installation, skip building and reinstalling:

```powershell
pwsh -File .\scripts\setup-mcp.ps1 -UseInstalledExtension
```

This uses `code --locate-extension timothymothra.lighthouse` and the installed package's bundled
helper. The PowerShell script is available in this source repository; users without it can use
the GUI fallback below. A Marketplace/local VSIX installation by itself does not register MCP.

### Explicit paths and profiles

```powershell
pwsh -File .\scripts\setup-mcp.ps1 `
    -CopilotHome 'C:\path\to\your\copilot-home' `
    -NodePath 'C:\Program Files\nodejs\node.exe' `
    -WorkspacePath 'C:\path\to\reviewed-worktree'
```

`-CopilotHome` defaults to `COPILOT_HOME`, otherwise `%USERPROFILE%\.copilot`.
Use the same directory as your ordinary CLI. `-WorkspacePath` selects only the read-only
verification location; it is **not** pinned in the global MCP registration.

`-CodePath` and `-CopilotPath` can select explicit CLI executables. For a non-default VS Code
user-data directory, supply `-CodeUserDataDirectory`. `-VsixPath` and `-UseInstalledExtension`
are mutually exclusive. npm/npx are required only for source packaging.

The GUI and script share an owned installation location independent of VS Code profiles:
on Windows, `%LOCALAPPDATA%\Lighthouse\copilot-mcp`. It records the selected CLI home and uses
a stable launcher plus versioned payloads. This shared installation targets one CLI home at
a time; remove its owned integration before switching to another home. No VS Code private
state database is edited.

### Extension host and filesystem

The GUI configures the CLI on **the machine/account running Lighthouse's Node extension host**.
Its bundled payload and the selected Node executable must be accessible there. The confirmation
shows that host context and the CLI configuration path; it does not configure a different machine.

Lighthouse declares workspace extension placement. With SSH, WSL, tunnels, or containers, install
it in the workspace extension host and run Copilot CLI on that same host/filesystem. A remote
window's UI-side extension host is rejected to avoid configuring the wrong machine. This is not
automatic deployment to another host or certification of every remote environment.

VS Code global-storage URI schemes such as `vscode-userdata` and `vscode-remote` are not used to
decide whether Node can access the installer files. Payload accessibility is checked through Node.
For the Windows script fallback, run `setup-mcp.ps1` on the actual CLI host.

## Finish without interrupting running work

The script deliberately does not reload an editor or restart a working agent:

1. In each VS Code window using Lighthouse, run **Developer: Reload Window**.
2. Open a new CLI session in the worktree containing your saved review:

   ```powershell
   Set-Location 'C:\path\to\reviewed-worktree'
   copilot
   ```

3. Enter `/mcp`, find **`lighthouse-codereview`**, and inspect its status/tools.
4. Ask for an actual read-only tool call:

   ```text
   Use lighthouse-codereview to list my Lighthouse reviews, then show the relevant
   thread index. Do not modify anything.
   ```

These checks distinguish an installed VSIX, a saved registration, a working standalone payload,
and an actually connected CLI session. The script verifies the first three; it cannot prove an
already-running CLI refreshed. If setup runs outside a Git worktree, protocol/tool verification
still runs, but the context check is explicitly reported as skipped.

The four tools are `list_reviews`, `get_review`, `get_thread`, and `reply_to_thread`. Thread-index
entries include the first 64 Unicode characters of the initial comment. For replies, ask:

```text
Use lighthouse-codereview to read my Lighthouse review discussions and reply to
my feedback in the relevant threads. Do not modify source code.
```

Replies leave thread resolution unchanged and appear through Lighthouse's existing file watcher.
The integration does not require `/ide`; VS Code can be closed after setup. Restart the MCP
connection/session after changing `/cwd` inside an existing CLI session.

## Manual fallback checklist

Use these steps if the script fails, or configure through the installed extension without the script.

1. Check prerequisites in the PowerShell environment where you normally launch Copilot:

   ```powershell
   node --version
   git --version
   copilot --version
   code --version
   ```

   Node must be 22+. If it is absent from VS Code's environment, select its executable explicitly
   in the setup dialog rather than guessing a different runtime.

2. Install the current build. From source, use the existing helper:

   ```powershell
   pwsh -File .\scripts\deploy-local.ps1
   ```

   Or install a current prebuilt VSIX:

   ```powershell
   code --install-extension 'C:\path\to\lighthouse.vsix' --force
   ```

3. Run **Developer: Reload Window** from VS Code's Command Palette.
4. In Lighthouse's top **Comparison** section, open the header's **…** menu and choose
   **Lighthouse: Configure Copilot CLI MCP**, then **Set up or repair**. The same command
   is also available in the Command Palette.
5. Confirm the CLI configuration directory, not the repository directory. To identify the usual
   default from your CLI-launching PowerShell environment:

   ```powershell
   if ($env:COPILOT_HOME) {
       $env:COPILOT_HOME
   } else {
       Join-Path $env:USERPROFILE '.copilot'
   }
   ```

6. Choose **Use Node.js from PATH** or select `node.exe`.
7. Review the `lighthouse-codereview` registration, launcher, four tools, and any owned-legacy
   migration. Click **Register Lighthouse MCP**.
8. Start a fresh CLI session in the reviewed worktree, inspect `/mcp`, and try the read-only
   request above. A configured server is not proof it has connected.

## Existing `lighthouse` registrations and conflicts

Setup recognizes the original `lighthouse` name only when its entry exactly matches a verified
Lighthouse ownership record for the same CLI home. It then replaces that owned key with
`lighthouse-codereview`, preserving other servers. Old payload files are retained so an existing
session is not interrupted.

An unrelated server named `lighthouse` is left alone. An unowned/edited
`lighthouse-codereview` entry causes setup to stop before replacing it. Resolve that conflict
explicitly; do not blindly delete another server.

A deliberately disabled owned legacy server is **not** migrated into a new enabled name.
If you intend to re-enable that owned integration, explicitly enable or remove it through
Copilot CLI before rerunning setup. Existing disabled-server settings and organization policy
are not bypassed. Setup never clears the CLI's `disabledMcpServers` list.

## Troubleshooting and partial outcomes

| Symptom | What to check |
|---|---|
| Missing command/runtime | Install the prerequisite yourself or supply its explicit path; the script does not install Node/VS Code/Copilot |
| “Automatic MCP setup currently supports local desktop VS Code…” | Update and reload Lighthouse; older builds incorrectly used the global-storage URI scheme and remote-window label as filesystem checks. The current build checks extension-host placement and disk paths instead |
| “UI extension host while the workspace is remote” | Run Lighthouse in the workspace extension host with CLI/Node on that host, or use the setup script on the Windows CLI host; no cross-machine registration is attempted |
| Build dependency/version errors after updating source | Run `npm ci` after dependency-manifest changes, then rerun setup; arbitrary build failures do not trigger a destructive reinstall/retry loop |
| Helper missing or identity/version mismatch | The VSIX is old or inconsistent; package the current source, not the pre-rename artifact |
| Registration collision | Inspect the named entry and ownership; MCP configuration is unchanged, although the extension may already be updated |
| Failure during installation | MCP registration has not been attempted; check the VS Code CLI/profile and permissions |
| “Registration was saved, but verification failed” | Treat this as a partial outcome; inspect `/mcp` and use GUI repair, rather than assuming configuration was rolled back |
| Protocol passed but worktree check skipped | Start a CLI in a Git worktree or rerun with `-WorkspacePath` pointing at one |
| Reviews have format/read issues | The server can be connected while saved data is invalid; inspect the reported issues rather than treating it as an empty review |
| Server absent from `/mcp` | Restart the CLI and check that setup targeted its actual `COPILOT_HOME` |
| Server disabled or denied by policy | Respect that setting/policy; setup does not enable it automatically |
| Empty review list | Confirm the correct worktree and post/save a Lighthouse comment first; opening a draft creates no review |
| Setup command absent in VS Code | Confirm the installed build/profile, then reload that window |
| Node executable moved/removed | Run setup/repair and choose the replacement runtime |

For removal, use **Lighthouse: Configure Copilot CLI MCP → Remove integration** before
uninstalling the extension. As a fallback, `copilot mcp remove lighthouse-codereview` removes
the user entry, but does not clean up the owned persistent payload. Removing a VSIX alone
does not remove independently installed CLI configuration.
