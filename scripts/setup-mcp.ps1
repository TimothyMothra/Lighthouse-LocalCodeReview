#requires -Version 5.1
<#
.SYNOPSIS
    Install Lighthouse and register the user-level lighthouse-codereview MCP server.
.DESCRIPTION
    By default, restores missing locked build dependencies, prepares one calendar version, packages the source checkout,
    installs the VSIX, registers the bundled server, and performs a read-only stdio probe.
    Use -VsixPath for an existing package, or -UseInstalledExtension after a Marketplace install.
    Never reloads VS Code, restarts a running CLI, changes trust, or submits a model prompt.
.EXAMPLE
    pwsh -File .\scripts\setup-mcp.ps1
.EXAMPLE
    pwsh -File .\scripts\setup-mcp.ps1 -WhatIf
.EXAMPLE
    pwsh -File .\scripts\setup-mcp.ps1 -VsixPath C:\Downloads\lighthouse.vsix
.EXAMPLE
    pwsh -File .\scripts\setup-mcp.ps1 -UseInstalledExtension
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$VsixPath,
    [switch]$UseInstalledExtension,
    [string]$CopilotHome = $(if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' }),
    [string]$NodePath = 'node',
    [string]$CodePath = 'code',
    [string]$CopilotPath = 'copilot',
    [string]$WorkspacePath = (Get-Location).Path,
    [string]$CodeUserDataDirectory
)

$ErrorActionPreference = 'Stop'
$serverName = 'lighthouse-codereview'
$extensionId = 'timothymothra.lighthouse'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stage = $null
$step = 'preflight'

function Write-Step([string]$Text) { Write-Host ('{0} {1}' -f (Get-Date -Format o), $Text) }
function Full-Path([string]$Value) {
    # Resolve against PowerShell's location, not System.IO's possibly stale CurrentDirectory.
    $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Value)
    if (-not [System.IO.Path]::IsPathRooted($resolved)) { throw "A filesystem path is required: $Value" }
    return $resolved
}
function Find-Tool([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }
    if ($Name -eq 'code') {
        $fallback = 'C:\Program Files\Microsoft VS Code\bin\code.cmd'
        if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
    }
    throw "Required command not found: $Name. Install it or provide its explicit path. See docs\mcp-setup.md."
}
function Invoke-Required([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$([System.IO.Path]::GetFileName($Command)) failed with exit code $LASTEXITCODE." }
}
function Read-Manifest([string]$File) {
    $manifest = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.name -ne 'lighthouse' -or $manifest.publisher -ine 'TimothyMothra' -or
        [string]::IsNullOrWhiteSpace($manifest.version)) {
        throw 'The package is not the expected TimothyMothra.lighthouse extension.'
    }
    return $manifest
}

if ($VsixPath -and $UseInstalledExtension) { throw 'Choose -VsixPath or -UseInstalledExtension, not both.' }
$CopilotHome = Full-Path $CopilotHome
$WorkspacePath = Full-Path $WorkspacePath
if (-not (Test-Path -LiteralPath $WorkspacePath -PathType Container)) { throw "Workspace directory does not exist: $WorkspacePath" }
if ($VsixPath) { $VsixPath = (Resolve-Path -LiteralPath $VsixPath).ProviderPath }
$mode = if ($UseInstalledExtension) { 'use the installed extension' } elseif ($VsixPath) { "install $VsixPath" } else { "prepare a new calendar version, build and install $repoRoot" }
Write-Step "Plan: $mode; register $serverName in $CopilotHome; verify without model calls."
if (-not $PSCmdlet.ShouldProcess((Join-Path $CopilotHome 'mcp-config.json'), "Configure $serverName ($mode)")) { return }

try {
    $node = Find-Tool $NodePath
    $code = Find-Tool $CodePath
    $null = Find-Tool $CopilotPath
    $null = Find-Tool 'git'
    $nodeVersion = (& $node --version) -join ''
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw 'Node.js 22+ is required. Use -NodePath to select it; no runtime is installed automatically.'
    }
    $codePrefix = @()
    if ($CodeUserDataDirectory) { $codePrefix = @('--user-data-dir', (Full-Path $CodeUserDataDirectory)) }
    $stage = Join-Path ([System.IO.Path]::GetTempPath()) ('lighthouse-mcp-setup-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null

    if ($UseInstalledExtension) {
        $step = 'locating the installed extension'
        Write-Step $step
        $locations = @(& $code @codePrefix --locate-extension $extensionId)
        if ($LASTEXITCODE -ne 0) { throw 'VS Code could not locate the installed extension.' }
        $locations = @($locations | Where-Object { Test-Path -LiteralPath $_ -PathType Container })
        if ($locations.Count -ne 1) { throw 'Could not identify exactly one installed Lighthouse extension. Check -CodePath and -CodeUserDataDirectory.' }
        $manifest = Read-Manifest (Join-Path $locations[0] 'package.json')
        $source = Join-Path $locations[0] 'out\mcp'
    }
    else {
        if (-not $VsixPath) {
            $step = 'building the source checkout'
            Write-Step $step
            $null = Read-Manifest (Join-Path $repoRoot 'package.json')
            $npm = Find-Tool 'npm'
            $npx = Find-Tool 'npx'
            Push-Location $repoRoot
            try {
                $probe = 'const r=require("node:module").createRequire(process.argv[1]);let missing=[];for(const id of ["typescript","esbuild","zod","proper-lockfile","@modelcontextprotocol/sdk/server/mcp.js","@vscode/vsce"]){try{r.resolve(id)}catch(e){if(e.code!=="MODULE_NOT_FOUND")throw e;missing.push(id)}}console.log(JSON.stringify(missing));process.exitCode=missing.length?2:0'
                if (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules') -PathType Container) {
                    $missingDependencies = @(& $node -e $probe (Join-Path $repoRoot 'package.json'))
                    $dependencyExit = $LASTEXITCODE
                }
                else { $dependencyExit = 2 }
                if ($dependencyExit -eq 2) {
                    Write-Step 'Missing build dependencies: restoring package-lock.json with npm ci.'
                    Invoke-Required $npm @('ci', '--no-audit', '--no-fund')
                }
                elseif ($dependencyExit -ne 0) { throw 'Dependency inspection failed; no automatic reinstall attempted.' }
                Write-Step 'Preparing the current-date version for this new source build.'
                Invoke-Required $npm @('run', 'version:prepare')
                $VsixPath = Join-Path $stage 'lighthouse.vsix'
                # VSCE's prepublish hook compiles and bundles; do not compile a second time here.
                Invoke-Required $npx @('--no-install', 'vsce', 'package', '--out', $VsixPath)
            }
            finally { Pop-Location }
        }

        $step = 'reading the bundled setup helper'
        Write-Step $step
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [System.IO.Compression.ZipFile]::OpenRead($VsixPath)
        try {
            $source = Join-Path $stage 'payload'
            New-Item -ItemType Directory -Path $source | Out-Null
            $manifestEntry = $archive.GetEntry('extension/package.json')
            if (-not $manifestEntry) { throw 'The VSIX has no extension manifest.' }
            $manifestFile = Join-Path $stage 'package.json'
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($manifestEntry, $manifestFile)
            $manifest = Read-Manifest $manifestFile
            foreach ($entry in $archive.Entries) {
                # Extract only flat trusted runtime assets; never expand arbitrary ZIP paths.
                if ($entry.FullName -match '^extension/out/mcp/(server\.cjs|setup\.cjs|THIRD-PARTY-NOTICES\.txt|(?:server|setup)\.cjs\.LEGAL\.txt)$') {
                    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $source $entry.Name))
                }
            }
        }
        finally { $archive.Dispose() }
    }

    $helper = Join-Path $source 'setup.cjs'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
        throw 'This build predates the automated setup helper. Build the current source or use the manual fallback in docs\mcp-setup.md.'
    }
    if (-not $UseInstalledExtension) {
        $step = 'installing the VSIX'
        Write-Step $step
        # VS Code must accept the package before any bundled JavaScript is executed.
        Invoke-Required $code ($codePrefix + @('--install-extension', $VsixPath, '--force'))
        $installed = @(& $code @codePrefix --list-extensions --show-versions)
        if ($LASTEXITCODE -ne 0 -or -not ($installed | Where-Object { $_ -ieq "$extensionId@$($manifest.version)" })) {
            throw 'VS Code did not report the expected installed extension version. MCP registration was not attempted.'
        }
    }

    $arguments = @($helper, '--home', $CopilotHome, '--node', $node, '--source', $source, '--workspace', $WorkspacePath)
    $step = 'checking registration ownership and runtime'
    Write-Step $step
    $preflightText = @(& $node @arguments --check)
    if ($LASTEXITCODE -ne 0) { throw 'MCP preflight failed. Registration was not attempted; the VSIX may already be installed.' }
    $preflight = ($preflightText -join "`n") | ConvertFrom-Json
    if ($preflight.serverName -ne $serverName -or $preflight.version -ne $manifest.version) {
        throw 'The bundled helper identity/version does not match the extension package.'
    }

    $step = 'registering and verifying the standalone MCP payload'
    Write-Step $step
    $resultText = @(& $node @arguments --yes)
    if ($LASTEXITCODE -ne 0) { throw 'Registration/protocol verification failed. Registration may already be saved; inspect the error and use the manual fallback.' }
    $result = ($resultText -join "`n") | ConvertFrom-Json
    Write-Step "Registered $($result.serverName); standalone protocol tools verified: $($result.toolsVerified -join ', ')."
    if ($result.contextVerified) {
        Write-Step "Worktree verified: $($result.workspaceRoot)"
        if (-not $result.reviewReadComplete) { Write-Warning 'The server works, but some saved reviews have read/format issues. Inspect them through the MCP tools.' }
    }
    else { Write-Warning $result.note }
    if ($result.migrateLegacy) { Write-Step 'Renamed the matching owned legacy entry. Its old payload was retained for existing sessions.' }
    Write-Host ''
    Write-Host 'Remaining manual steps (to avoid interrupting your work):'
    Write-Host '  1. In VS Code: Developer: Reload Window.'
    Write-Host '  2. Start a fresh Copilot CLI session in the reviewed worktree; inspect /mcp.'
    Write-Host "  3. Ask Copilot to use $serverName to list Lighthouse reviews."
    Write-Host 'A saved entry and standalone probe do not prove an already-running CLI or VS Code window refreshed.'
}
catch {
    Write-Error "Lighthouse MCP setup failed during ${step}: $($_.Exception.Message)"
    throw
}
finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop
    }
}
