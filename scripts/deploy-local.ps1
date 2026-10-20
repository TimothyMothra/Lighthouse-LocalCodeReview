#requires -Version 5.1
<#
.SYNOPSIS
    Build the Lighthouse extension and install it into local (host) VS Code.

.DESCRIPTION
    Prepares today's calendar version once, then compiles + packages the extension into
    <name>-<version>.vsix (at repo root, already gitignored) and installs it with
    `code --install-extension ... --force`.

.PARAMETER InstallOnly
    Skip version preparation, compile and package; reinstall the existing .vsix unchanged.

.EXAMPLE
    pwsh -File scripts/deploy-local.ps1            # build + install
    pwsh -File scripts/deploy-local.ps1 -InstallOnly  # reinstall existing .vsix
#>
[CmdletBinding()]
param(
    [switch]$InstallOnly
)

$ErrorActionPreference = 'Stop'

# Repo root = parent of this script's directory, so cwd doesn't matter.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Push-Location $repoRoot
try {
    if (-not $InstallOnly) {
        Write-Host ("{0} ==> Preparing a new calendar build version..." -f (Get-Date -Format o)) -ForegroundColor Cyan
        npm run version:prepare
        if ($LASTEXITCODE -ne 0) { throw "Version preparation failed (exit $LASTEXITCODE)." }
    }
    # Read after preparation so the selected artifact cannot retain yesterday's filename.
    $manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($manifest.name) -or [string]::IsNullOrWhiteSpace($manifest.version)) {
        throw 'package.json must contain a nonempty name and version to locate the VSIX.'
    }
    $vsix = Join-Path $repoRoot ('{0}-{1}.vsix' -f $manifest.name, $manifest.version)

    if (-not $InstallOnly) {
        # VSCE checks the prepared date/metadata, then compiles exactly once in its prepublish hook.
        Write-Host "==> Packaging (npx @vscode/vsce package)..." -ForegroundColor Cyan
        npx @vscode/vsce package
        if ($LASTEXITCODE -ne 0) { throw "vsce package failed (exit $LASTEXITCODE)." }
    }

    if (-not (Test-Path $vsix)) {
        throw "Expected .vsix not found at $vsix. Run without -InstallOnly to build it first."
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($vsix)
    try {
        $entry = $archive.GetEntry('extension/package.json')
        if (-not $entry) { throw 'The VSIX has no extension manifest.' }
        $reader = New-Object System.IO.StreamReader($entry.Open())
        try { $packaged = $reader.ReadToEnd() | ConvertFrom-Json }
        finally { $reader.Dispose() }
        $expectedTitle = '{0} ({1})' -f $manifest.displayName, $manifest.version
        $packagedTitle = @($packaged.contributes.viewsContainers.activitybar | Where-Object { $_.id -eq 'lighthouse' })
        if ($packaged.version -ne $manifest.version -or $packaged.name -ne $manifest.name -or
            $packaged.publisher -ine $manifest.publisher -or $packagedTitle.Count -ne 1 -or $packagedTitle[0].title -ne $expectedTitle) {
            throw 'The packaged version/identity/header differs from the prepared manifest. Installation was not attempted.'
        }
    }
    finally { $archive.Dispose() }

    # Locate the `code` CLI: PATH first, then the default install location.
    $codeCmd = (Get-Command code -ErrorAction SilentlyContinue).Source
    if (-not $codeCmd) {
        $fallback = 'C:\Program Files\Microsoft VS Code\bin\code.cmd'
        if (Test-Path $fallback) { $codeCmd = $fallback }
    }
    if (-not $codeCmd) {
        throw "Could not find the 'code' CLI on PATH or at 'C:\Program Files\Microsoft VS Code\bin\code.cmd'."
    }

    Write-Host "==> Installing via $codeCmd ..." -ForegroundColor Cyan
    & $codeCmd --install-extension $vsix --force
    if ($LASTEXITCODE -ne 0) { throw "code --install-extension failed (exit $LASTEXITCODE)." }

    $extensionId = ('{0}.{1}' -f $manifest.publisher, $manifest.name).ToLowerInvariant()
    $installed = @(& $codeCmd --list-extensions --show-versions)
    if ($LASTEXITCODE -ne 0 -or -not ($installed | Where-Object { $_ -ieq "$extensionId@$($manifest.version)" })) {
        throw 'VS Code did not report the expected installed version.'
    }
    $location = & $codeCmd --locate-extension $extensionId
    if ($LASTEXITCODE -ne 0 -or -not $location) { throw 'Could not inspect the installed extension.' }
    $installedManifest = Get-Content -LiteralPath (Join-Path $location 'package.json') -Raw | ConvertFrom-Json
    $installedTitle = @($installedManifest.contributes.viewsContainers.activitybar | Where-Object { $_.id -eq 'lighthouse' })
    if ($installedManifest.version -ne $manifest.version -or $installedTitle.Count -ne 1 -or $installedTitle[0].title -ne $expectedTitle) {
        throw 'The installed manifest/header does not match the prepared build.'
    }
    Write-Host "==> Version audit passed: source / VSIX / installed = $($manifest.version)" -ForegroundColor Green

    Write-Host ""
    Write-Host "Done. In VS Code run 'Developer: Reload Window' to pick up the new build." -ForegroundColor Green
}
finally {
    Pop-Location
}
