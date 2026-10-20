const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');

function fixture({ confirm = false, trusted = true, failPrepare = false, remoteName, kind = 1, storageScheme = 'file', extensionPath } = {}) {
	const calls = [], errors = [], notices = [], warnings = [], updates = [];
	let picks = 0;
	const home = path.resolve('synthetic-cli-home'), storage = path.resolve('synthetic-global-storage');
	const vscode = {
		env: { remoteName }, ExtensionKind: { UI: 1, Workspace: 2 }, workspace: { isTrusted: trusted },
		window: {
			showQuickPick: async () => ++picks === 1 ? { value: 'setup' } : { value: 'select' },
			showInputBox: async () => home,
			showOpenDialog: async () => [{ fsPath: process.execPath }],
			showInformationMessage: async (message) => { notices.push(message); return confirm ? 'Register Lighthouse MCP' : undefined; },
			showErrorMessage: (message) => errors.push(message),
			showWarningMessage: (message) => warnings.push(message),
		},
	};
	const installation = {
		installedConfigHome: async () => undefined,
		prepareRegistration: async (...args) => {
			calls.push('prepare');
			if (failPrepare) { throw new Error('Synthetic unsupported Node runtime'); }
			return { configHome: home, storage: args[1], entry: { args: [path.join(args[1], 'launcher.cjs')], tools: ['list_reviews', 'get_review', 'get_thread', 'reply_to_thread'] } };
		},
		applyRegistration: async () => calls.push('apply'),
		refreshPayload: async () => calls.push('refresh'),
	};
	const filename = path.resolve(__dirname, '..', 'out', 'mcpConfiguration.js');
	const module = { exports: {} }, nativeRequire = createRequire(filename);
	vm.runInThisContext(wrap(fs.readFileSync(filename, 'utf8')), { filename })(
		module.exports, (id) => id === 'vscode' ? vscode : id === './mcpInstallation' ? installation : nativeRequire(id),
		module, filename, path.dirname(filename),
	);
	return {
		...module.exports, calls, errors, notices, warnings, updates,
		context: { globalStorageUri: { scheme: storageScheme, fsPath: storage }, extensionPath: extensionPath ?? path.resolve('synthetic-extension'),
			extension: { extensionKind: kind, packageJSON: { version: '1.0.0' } },
			globalState: { get: () => undefined, update: async (...args) => updates.push(args) } },
	};
}

test('the user can preview setup and cancel without applying configuration or marking it enabled', async () => {
	const f = fixture();
	await f.configureCopilotMcp(f.context);
	assert.deepEqual(f.calls, ['prepare']);
	assert.deepEqual(f.updates, []);
	assert.equal(f.errors.length, 0);
	assert.match(f.notices[0], /No repository is pinned/);
});

test('explicit confirmation applies one user entry and records the selected CLI profile only after success', async () => {
	const f = fixture({ confirm: true });
	await f.configureCopilotMcp(f.context);
	assert.deepEqual(f.calls, ['prepare', 'apply']);
	assert.equal(f.updates.length, 1);
	assert.equal(f.updates[0][0], 'mcp.userInstallation');
	assert.match(f.notices.at(-1), /configured for new CLI sessions/);
});

test('untrusted workspaces and runtime failures surface errors without success-shaped configuration', async () => {
	for (const options of [{ trusted: false }, { failPrepare: true }]) {
		const f = fixture({ confirm: true, ...options });
		await f.configureCopilotMcp(f.context);
		assert.ok(!f.calls.includes('apply'));
		assert.equal(f.updates.length, 0);
		assert.equal(f.errors.length, 1);
		assert.match(f.errors[0], /setup failed/);
	}
});

test('provider-backed storage does not block local Node-host setup or previously opted-in payload refresh', async () => {
	for (const storageScheme of ['vscode-userdata', 'vscode-remote']) {
		const f = fixture({ confirm: true, storageScheme });
		await f.configureCopilotMcp(f.context);
		assert.deepEqual(f.calls, ['prepare', 'apply']);
		assert.equal(f.errors.length, 0);
		await f.refreshCopilotMcp(f.context);
		assert.equal(f.calls.at(-1), 'refresh');
	}
});

test('a remote workspace Node host can configure its own CLI, but a remote-window UI host cannot', async () => {
	const workspace = fixture({ confirm: true, remoteName: 'tunnel', kind: 2, storageScheme: 'vscode-remote' });
	await workspace.configureCopilotMcp(workspace.context);
	assert.deepEqual(workspace.calls, ['prepare', 'apply']);
	assert.equal(workspace.errors.length, 0);
	assert.match(workspace.notices[0], /remote workspace \(tunnel\)/);
	await workspace.refreshCopilotMcp(workspace.context);
	assert.equal(workspace.calls.at(-1), 'refresh');
	const ui = fixture({ confirm: true, remoteName: 'ssh-remote', kind: 1, storageScheme: 'file' });
	await ui.configureCopilotMcp(ui.context);
	assert.deepEqual(ui.calls, []);
	assert.equal(ui.updates.length, 0);
	assert.match(ui.errors[0], /UI extension host.*workspace is remote/);
	await ui.refreshCopilotMcp(ui.context);
	assert.deepEqual(ui.calls, []);
	assert.equal(ui.warnings.length, 1);
});

test('non-disk extension paths fail explicitly before registration rather than relying on the storage provider', async () => {
	const f = fixture({ confirm: true, extensionPath: 'vscode-remote://synthetic/extension' });
	await f.configureCopilotMcp(f.context);
	assert.deepEqual(f.calls, []);
	assert.match(f.errors[0], /disk-backed extension path/);
});
