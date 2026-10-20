const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { prepareRegistration, applyRegistration, refreshPayload, removeRegistration } = require('../out/mcpInstallation');
const { repository } = require('./mcp-fixture.cjs');
const { withReviewFileLock } = require('../out/reviewPersistence');
const NAME = 'lighthouse-codereview';

async function fixture(t, config = { mcpServers: { unrelated: { type: 'http', url: 'https://example.invalid/mcp' } }, disabledServers: ['unrelated'] }) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighthouse-mcp-install-'));
	const home = path.join(root, 'custom cli home'), storage = path.join(root, 'persistent payload'), source = path.join(root, 'old extension version');
	await fs.mkdir(home); await fs.mkdir(source);
	for (const name of await fs.readdir(path.resolve(__dirname, '..', 'out', 'mcp'))) {
		await fs.copyFile(path.resolve(__dirname, '..', 'out', 'mcp', name), path.join(source, name));
	}
	const file = path.join(home, 'mcp-config.json');
	await fs.writeFile(file, JSON.stringify(config));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return { root, home, storage, source, file, config, prepare: () => prepareRegistration(home, storage, source, '1.0.0', process.execPath) };
}

async function invoke(entry, directory) {
	const client = new Client({ name: 'synthetic-registration-test', version: '1.0.0' });
	await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, cwd: directory }));
	try {
		assert.equal(client.getServerVersion().name, NAME);
		const result = await client.callTool({ name: 'list_reviews', arguments: {} });
		return result.structuredContent;
	} finally { await client.close(); }
}

test('setup is opt-in, preserves other configuration, and one installed launcher works across new repositories', async (t) => {
	const f = await fixture(t);
	const original = await fs.readFile(f.file, 'utf8');
	const pending = await f.prepare();
	assert.equal(await fs.readFile(f.file, 'utf8'), original);
	await assert.rejects(fs.stat(f.storage), { code: 'ENOENT' });
	await applyRegistration(pending);
	const config = JSON.parse(await fs.readFile(f.file, 'utf8'));
	assert.deepEqual(config.mcpServers.unrelated, f.config.mcpServers.unrelated);
	assert.deepEqual(config.disabledServers, ['unrelated']);
	assert.ok(!Object.hasOwn(config.mcpServers[NAME], 'workingDirectory'));
	assert.deepEqual(config.mcpServers[NAME].tools, ['list_reviews', 'get_review', 'get_thread', 'reply_to_thread']);
	for (const name of ['new repo a', 'new repo b']) {
		const directory = path.join(f.root, name);
		await repository(directory);
		const result = await invoke(config.mcpServers[NAME], directory);
		assert.equal(result.workspaceRoot.toLowerCase(), directory.toLowerCase());
		assert.deepEqual(result.items, []);
		await assert.rejects(fs.stat(path.join(directory, '.mcp.json')), { code: 'ENOENT' });
	}
	await removeRegistration(f.storage);
	assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), f.config);
	await assert.rejects(fs.stat(path.join(f.storage, 'payloads')), { code: 'ENOENT' });
});

test('payload refresh survives deletion of versioned extension files without altering CLI settings', async (t) => {
	const f = await fixture(t);
	await applyRegistration(await f.prepare());
	const originalConfig = await fs.readFile(f.file, 'utf8'), newer = path.join(f.root, 'new extension version');
	await fs.cp(f.source, newer, { recursive: true });
	await fs.appendFile(path.join(newer, 'server.cjs'), '\n// synthetic version update\n');
	await fs.rm(f.source, { recursive: true });
	assert.equal(await refreshPayload(f.storage, newer, '2.0.0'), true);
	assert.equal(await fs.readFile(f.file, 'utf8'), originalConfig);
	assert.equal(JSON.parse(await fs.readFile(path.join(f.storage, 'current.json'), 'utf8')).version, '2.0.0');
	await fs.rm(newer, { recursive: true });
	const directory = path.join(f.root, 'closed vscode workspace');
	await repository(directory);
	assert.equal((await invoke(JSON.parse(originalConfig).mcpServers[NAME], directory)).workspaceRoot.toLowerCase(), directory.toLowerCase());
	assert.equal(await refreshPayload(f.storage, newer, '1.0.0'), false);
});

test('registration refuses changed, malformed, colliding and missing-runtime inputs without replacing configuration', async (t) => {
	const f = await fixture(t);
	const pending = await f.prepare();
	const changed = JSON.stringify({ ...f.config, concurrent: 'preserve' });
	await fs.writeFile(f.file, changed);
	await assert.rejects(applyRegistration(pending), /changed during confirmation/);
	assert.equal(await fs.readFile(f.file, 'utf8'), changed);
	const malformed = '{"token":"SYNTHETIC_DO_NOT_REPORT",}';
	await fs.writeFile(f.file, malformed);
	await assert.rejects(f.prepare(), (error) => {
		assert.match(error.message, /not valid JSON/);
		assert.ok(!error.message.includes('SYNTHETIC_DO_NOT_REPORT'));
		return true;
	});
	assert.equal(await fs.readFile(f.file, 'utf8'), malformed);
	const collision = JSON.stringify({ mcpServers: { [NAME]: { type: 'http', url: 'https://example.invalid/unowned' } } });
	await fs.writeFile(f.file, collision);
	await assert.rejects(f.prepare(), /different or edited/);
	assert.equal(await fs.readFile(f.file, 'utf8'), collision);
	await fs.writeFile(f.file, changed);
	await assert.rejects(prepareRegistration(f.home, f.storage, f.source, '1.0.0', path.join(f.root, 'missing-node.exe')));
	assert.equal(await fs.readFile(f.file, 'utf8'), changed);
});

test('an edited entry is never silently removed or re-enabled by payload maintenance', async (t) => {
	const f = await fixture(t);
	await applyRegistration(await f.prepare());
	const config = JSON.parse(await fs.readFile(f.file, 'utf8'));
	config.mcpServers[NAME].env = { USER_CUSTOMIZATION: 'preserve' };
	config.disabledServers.push(NAME);
	await fs.writeFile(f.file, JSON.stringify(config));
	const changed = await fs.readFile(f.file, 'utf8');
	assert.equal(await refreshPayload(f.storage, f.source, '2.0.0'), false);
	await assert.rejects(removeRegistration(f.storage), /edited or replaced/);
	assert.equal(await fs.readFile(f.file, 'utf8'), changed);
	await fs.access(path.join(f.storage, 'launcher.cjs'));
});

test('explicit repair replaces a corrupt owned payload without leaving the launcher pointed at bad code', async (t) => {
	const f = await fixture(t);
	await applyRegistration(await f.prepare());
	const current = JSON.parse(await fs.readFile(path.join(f.storage, 'current.json'), 'utf8'));
	await fs.writeFile(path.join(f.storage, ...current.payload.split('/')), 'corrupted synthetic payload');
	await applyRegistration(await f.prepare());
	const repaired = JSON.parse(await fs.readFile(path.join(f.storage, 'current.json'), 'utf8'));
	assert.notEqual(repaired.payload, current.payload);
	const directory = path.join(f.root, 'repaired workspace');
	await repository(directory);
	const config = JSON.parse(await fs.readFile(f.file, 'utf8'));
	assert.equal((await invoke(config.mcpServers[NAME], directory)).workspaceRoot.toLowerCase(), directory.toLowerCase());
});

test('explicit setup refuses downgrade, including a refresh completed during confirmation', async (t) => {
	const f = await fixture(t);
	await applyRegistration(await f.prepare());
	const pending = await f.prepare();
	assert.equal(await refreshPayload(f.storage, f.source, '2.0.0'), true);
	const files = [f.file, ...['installation.json', 'current.json', 'launcher.cjs'].map((name) => path.join(f.storage, name))];
	const snapshots = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')));
	for (const registration of [pending, await f.prepare()]) {
		await assert.rejects(applyRegistration(registration), /newer.*already installed/i);
		for (let index = 0; index < files.length; index++) {
			assert.equal(await fs.readFile(files[index], 'utf8'), snapshots[index]);
		}
	}
});

test('setup rechecks the shared installation profile after confirmation', async (t) => {
	const f = await fixture(t), pending = await f.prepare();
	const original = await fs.readFile(f.file, 'utf8'), otherHome = path.join(f.root, 'another cli home');
	await applyRegistration(await prepareRegistration(otherHome, f.storage, f.source, '1.0.0', process.execPath));
	const ownerFile = path.join(f.storage, 'installation.json'), owner = await fs.readFile(ownerFile, 'utf8');
	await assert.rejects(applyRegistration(pending), /different CLI configuration directory/);
	assert.equal(await fs.readFile(f.file, 'utf8'), original);
	assert.equal(await fs.readFile(ownerFile, 'utf8'), owner);
	assert.equal(JSON.parse(owner).configHome, otherHome);
});

async function legacyFixture(t) {
	const f = await fixture(t);
	await applyRegistration(await f.prepare());
	const config = JSON.parse(await fs.readFile(f.file, 'utf8'));
	config.mcpServers.lighthouse = config.mcpServers[NAME];
	delete config.mcpServers[NAME];
	await fs.writeFile(f.file, JSON.stringify(config));
	const ownerFile = path.join(f.storage, 'installation.json');
	const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
	delete owner.serverName; // Actual pre-rename ownership format.
	await fs.writeFile(ownerFile, JSON.stringify(owner));
	return f;
}

test('the short legacy name is retained when it belongs to an unrelated server', async (t) => {
	const unrelated = { type: 'http', url: 'https://example.invalid/unrelated-lighthouse', tools: ['*'] };
	const f = await fixture(t, { mcpServers: { lighthouse: unrelated } });
	const prepared = await f.prepare();
	assert.equal(prepared.migrateLegacy, false);
	await applyRegistration(prepared);
	const config = JSON.parse(await fs.readFile(f.file, 'utf8'));
	assert.deepEqual(config.mcpServers.lighthouse, unrelated);
	assert.ok(config.mcpServers[NAME]);
});

test('an owned pre-rename registration migrates to the new name/storage without deleting the old running payload', async (t) => {
	const f = await legacyFixture(t), nextStorage = path.join(f.root, 'shared user storage');
	const prepared = await prepareRegistration(f.home, nextStorage, f.source, '2.0.0', process.execPath);
	assert.equal(prepared.migrateLegacy, true);
	await applyRegistration(prepared);
	const config = JSON.parse(await fs.readFile(f.file, 'utf8'));
	assert.ok(!Object.hasOwn(config.mcpServers, 'lighthouse'));
	assert.equal(config.mcpServers[NAME].args[0], path.join(nextStorage, 'launcher.cjs'));
	await fs.access(path.join(f.storage, 'launcher.cjs'));
	assert.deepEqual(config.mcpServers.unrelated, f.config.mcpServers.unrelated);
	assert.equal(JSON.parse(await fs.readFile(path.join(nextStorage, 'installation.json'), 'utf8')).serverName, NAME);
});

test('legacy migration does not bypass a saved disablement or a disablement made after preflight', async (t) => {
	const f = await legacyFixture(t), nextStorage = path.join(f.root, 'shared user storage');
	const original = await fs.readFile(f.file, 'utf8');
	const prepared = await prepareRegistration(f.home, nextStorage, f.source, '2.0.0', process.execPath);
	const settings = path.join(f.home, 'settings.json');
	await fs.writeFile(settings, JSON.stringify({ disabledMcpServers: ['lighthouse'], theme: 'preserve' }));
	await assert.rejects(applyRegistration(prepared), /disabled/);
	await assert.rejects(prepareRegistration(f.home, nextStorage, f.source, '2.0.0', process.execPath), /disabled/);
	assert.equal(await fs.readFile(f.file, 'utf8'), original);
	await assert.rejects(fs.stat(nextStorage), { code: 'ENOENT' });
});

test('a waiting older window rechecks ownership/version after a newer profile commits', async (t) => {
	const f = await fixture(t);
	await applyRegistration(await f.prepare());
	const ownerFile = path.join(f.storage, 'installation.json'), currentFile = path.join(f.storage, 'current.json');
	let release, acquired;
	const started = new Promise((resolve) => { acquired = resolve; });
	const holding = withReviewFileLock(ownerFile, async () => { acquired(); await new Promise((resolve) => { release = resolve; }); });
	await started;
	const readFile = fs.readFile;
	let observed;
	const firstRead = new Promise((resolve) => { observed = resolve; });
	fs.readFile = async (...args) => {
		const data = await readFile(...args);
		if (args[0] === ownerFile) { observed(); }
		return data;
	};
	try {
		const pending = refreshPayload(f.storage, f.source, '2.0.0');
		await firstRead;
		fs.readFile = readFile;
		const owner = JSON.parse(await readFile(ownerFile, 'utf8')), current = JSON.parse(await readFile(currentFile, 'utf8'));
		owner.version = current.version = '3.0.0';
		await fs.writeFile(ownerFile, JSON.stringify(owner));
		await fs.writeFile(currentFile, JSON.stringify(current));
		release(); await holding;
		assert.equal(await pending, false);
		assert.equal(JSON.parse(await readFile(currentFile, 'utf8')).version, '3.0.0');
	} finally { fs.readFile = readFile; release(); await holding; }
});
