const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { repository } = require('./mcp-fixture.cjs');

const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const setup = path.join(root, 'scripts', 'setup-mcp.ps1');
const manifest = require('../package.json');
const NAME = 'lighthouse-codereview';
const windows = { skip: process.platform !== 'win32' ? 'Windows PowerShell setup integration' : false };

async function fixture(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lighthouse-setup-script-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const packageRoot = path.join(directory, 'package'), extension = path.join(packageRoot, 'extension');
	const payload = path.join(extension, 'out', 'mcp');
	await fs.mkdir(payload, { recursive: true });
	await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify(manifest));
	for (const file of await fs.readdir(path.join(root, 'out', 'mcp'))) {
		await fs.copyFile(path.join(root, 'out', 'mcp', file), path.join(payload, file));
	}
	const zipScript = path.join(directory, 'zip.ps1'), vsix = path.join(directory, 'lighthouse.vsix');
	await fs.writeFile(zipScript, `param([string]$Source,[string]$Target)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[System.IO.Compression.ZipFile]::CreateFromDirectory($Source,$Target)\n`);
	await exec('pwsh', ['-NoProfile', '-File', zipScript, packageRoot, vsix], { windowsHide: true });
	const code = path.join(directory, 'fake code.ps1'), log = path.join(directory, 'code-arguments.jsonl');
	await fs.writeFile(code, `
$items = @($args)
[System.IO.File]::AppendAllText($env:LIGHTHOUSE_TEST_CODE_LOG, (ConvertTo-Json -InputObject $items -Compress) + "\`n")
if ($items -contains '--install-extension') {
    if ($env:LIGHTHOUSE_TEST_FAIL_INSTALL -eq '1') { exit 3 }
    exit 0
}
if ($items -contains '--list-extensions') { Write-Output ('timothymothra.lighthouse@' + $env:LIGHTHOUSE_TEST_VERSION); exit 0 }
if ($items -contains '--locate-extension') {
    if ($items[-1] -cne 'timothymothra.lighthouse') { exit 0 }
    Write-Output $env:LIGHTHOUSE_TEST_EXTENSION
    exit 0
}
exit 0
`);
	const workspace = path.join(directory, 'reviewed worktree'), home = path.join(directory, 'custom copilot home'), local = path.join(directory, 'local data');
	await repository(workspace);
	const env = {
		...process.env, LOCALAPPDATA: local, LIGHTHOUSE_TEST_CODE_LOG: log,
		LIGHTHOUSE_TEST_VERSION: manifest.version, LIGHTHOUSE_TEST_EXTENSION: extension,
	};
	const common = ['-CopilotHome', home, '-NodePath', process.execPath,
		'-CodePath', code, '-CopilotPath', code, '-WorkspacePath', workspace];
	return {
		directory, vsix, workspace, home, log, env, code, storage: path.join(local, 'Lighthouse', 'copilot-mcp'),
		run: (args = [], overrides = {}, script = setup) => exec('pwsh', ['-NoProfile', '-File', script, ...common, ...args], {
			cwd: directory, env: { ...env, ...overrides }, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
		}),
	};
}

test('setup script installs a supplied VSIX, registers/probes once, and supports an already-installed extension', windows, async (t) => {
	const f = await fixture(t);
	const first = await f.run(['-VsixPath', f.vsix, '-Confirm:$false']);
	assert.match(first.stdout, /Registered lighthouse-codereview/);
	assert.match(first.stdout, /Worktree verified/);
	assert.match(first.stdout, /Remaining manual steps/);
	const config = JSON.parse(await fs.readFile(path.join(f.home, 'mcp-config.json'), 'utf8'));
	assert.deepEqual(Object.keys(config.mcpServers), [NAME]);
	assert.equal(config.mcpServers[NAME].args[0], path.join(f.storage, 'launcher.cjs'));
	assert.ok(!Object.hasOwn(config.mcpServers[NAME], 'workingDirectory'));
	const owner = JSON.parse(await fs.readFile(path.join(f.storage, 'installation.json'), 'utf8'));
	assert.equal(owner.serverName, NAME);
	const before = await fs.readFile(path.join(f.home, 'mcp-config.json'), 'utf8');
	const second = await f.run(['-UseInstalledExtension', '-Confirm:$false']);
	assert.match(second.stdout, /standalone protocol tools verified/);
	assert.equal(await fs.readFile(path.join(f.home, 'mcp-config.json'), 'utf8'), before);
	const invocations = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
	assert.equal(invocations.filter((args) => args.includes('--install-extension')).length, 1);
	assert.equal(invocations.filter((args) => args.includes('--locate-extension')).length, 1);
});

test('a fresh source checkout restores missing locked dependencies before packaging', windows, async (t) => {
	const f = await fixture(t), checkout = path.join(f.directory, 'fresh source'), bin = path.join(f.directory, 'fake build commands');
	await fs.mkdir(path.join(checkout, 'scripts'), { recursive: true });
	await fs.mkdir(bin);
	const script = path.join(checkout, 'scripts', 'setup-mcp.ps1');
	await fs.copyFile(setup, script);
	await fs.copyFile(path.join(root, 'package.json'), path.join(checkout, 'package.json'));
	await fs.copyFile(path.join(root, 'package-lock.json'), path.join(checkout, 'package-lock.json'));
	const buildLog = path.join(f.directory, 'build-commands.jsonl');
	await fs.writeFile(path.join(bin, 'npm.ps1'), `
[System.IO.File]::AppendAllText($env:LIGHTHOUSE_TEST_BUILD_LOG, (ConvertTo-Json -InputObject @($args) -Compress) + "\`n")
if ($args[0] -eq 'ci') { New-Item -ItemType Directory -Path (Join-Path (Get-Location).Path 'node_modules') | Out-Null }
exit 0
`);
	await fs.writeFile(path.join(bin, 'npx.ps1'), `
[System.IO.File]::AppendAllText($env:LIGHTHOUSE_TEST_BUILD_LOG, (ConvertTo-Json -InputObject @($args) -Compress) + "\`n")
$index = [Array]::IndexOf([string[]]$args, '--out')
Copy-Item -LiteralPath $env:LIGHTHOUSE_TEST_VSIX -Destination $args[$index + 1]
exit 0
`);
	const search = bin + path.delimiter + process.env.PATH;
	const result = await f.run(['-Confirm:$false'], {
		PATH: search, Path: search, LIGHTHOUSE_TEST_BUILD_LOG: buildLog, LIGHTHOUSE_TEST_VSIX: f.vsix,
	}, script);
	assert.match(result.stdout, /Missing build dependencies/);
	assert.match(result.stdout, /Registered lighthouse-codereview/);
	const commands = (await fs.readFile(buildLog, 'utf8')).trim().split('\n').map(JSON.parse);
	assert.deepEqual(commands[0], ['ci', '--no-audit', '--no-fund']);
	assert.deepEqual(commands[1], ['run', 'version:prepare']);
	assert.deepEqual(commands[2].slice(0, 3), ['--no-install', 'vsce', 'package']);
});

test('WhatIf performs no native installation, registration or payload creation', windows, async (t) => {
	const f = await fixture(t);
	const result = await f.run(['-VsixPath', f.vsix, '-WhatIf']);
	assert.match(result.stdout, /What if:/i);
	for (const file of [f.log, f.home, f.storage]) { await assert.rejects(fs.stat(file), { code: 'ENOENT' }); }
});

test('a name collision leaves MCP configuration untouched after VS Code accepts the package', windows, async (t) => {
	const f = await fixture(t), file = path.join(f.home, 'mcp-config.json');
	await fs.mkdir(f.home);
	const original = JSON.stringify({ mcpServers: { [NAME]: { type: 'http', url: 'https://example.invalid/unowned' } } });
	await fs.writeFile(file, original);
	await assert.rejects(f.run(['-VsixPath', f.vsix, '-Confirm:$false']), (error) => {
		assert.match(error.stderr, /different or edited|preflight failed/i);
		return true;
	});
	assert.equal(await fs.readFile(file, 'utf8'), original);
	const invocations = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
	assert.equal(invocations.filter((args) => args.includes('--install-extension')).length, 1);
	await assert.rejects(fs.stat(f.storage), { code: 'ENOENT' });
});

test('an extension-install failure does not proceed with MCP registration', windows, async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.run(['-VsixPath', f.vsix, '-Confirm:$false'], { LIGHTHOUSE_TEST_FAIL_INSTALL: '1' }), (error) => {
		assert.match(error.stderr, /installing the VSIX/);
		return true;
	});
	await assert.rejects(fs.stat(f.home), { code: 'ENOENT' });
	await assert.rejects(fs.stat(f.storage), { code: 'ENOENT' });
	const invocations = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
	assert.equal(invocations.length, 1);
});

async function cachedDeployment(t, mismatch = false) {
	const f = await fixture(t), checkout = path.join(f.directory, 'cached checkout'), bin = path.join(f.directory, 'code cli');
	await fs.mkdir(path.join(checkout, 'scripts'), { recursive: true });
	await fs.mkdir(bin);
	await fs.copyFile(path.join(root, 'scripts', 'deploy-local.ps1'), path.join(checkout, 'scripts', 'deploy-local.ps1'));
	await fs.copyFile(f.code, path.join(bin, 'code.ps1'));
	const cachedManifest = JSON.parse(JSON.stringify(manifest));
	if (mismatch) {
		cachedManifest.version = '2027.101.1';
		cachedManifest.contributes.viewsContainers.activitybar[0].title = `${manifest.displayName} (${cachedManifest.version})`;
	}
	await fs.writeFile(path.join(checkout, 'package.json'), JSON.stringify(cachedManifest));
	await fs.copyFile(f.vsix, path.join(checkout, `lighthouse-${cachedManifest.version}.vsix`));
	const search = bin + path.delimiter + process.env.PATH;
	return { ...f, checkout, runDeploy: () => exec('pwsh', ['-NoProfile', '-File', path.join(checkout, 'scripts', 'deploy-local.ps1'), '-InstallOnly'], {
		cwd: f.directory, env: { ...f.env, PATH: search, Path: search }, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
	}) };
}

test('cached deployment does not allocate a version and audits archive/installed header metadata', windows, async (t) => {
	const f = await cachedDeployment(t);
	const original = await fs.readFile(path.join(f.checkout, 'package.json'), 'utf8');
	const result = await f.runDeploy();
	assert.match(result.stdout, /Version audit passed: source \/ VSIX \/ installed/);
	assert.equal(await fs.readFile(path.join(f.checkout, 'package.json'), 'utf8'), original);
});

test('deployment refuses a cached filename whose actual VSIX version differs before installing it', windows, async (t) => {
	const f = await cachedDeployment(t, true);
	await assert.rejects(f.runDeploy(), (error) => {
		assert.match(error.stderr, /packaged version\/identity\/header differs/);
		return true;
	});
	await assert.rejects(fs.stat(f.log), { code: 'ENOENT' });
});
