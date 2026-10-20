const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { calendarParts, nextVersion, checkVersion, prepareVersion } = require('./build-version.cjs');

const today = new Date(2026, 9, 20, 12);
function fixture(t, version = '2026.1019.7') {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lighthouse-build-version-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const manifest = {
		name: 'lighthouse', private: true, displayName: 'Lighthouse: Local Code Review', version,
		scripts: { version: 'node -e "require(\'fs\').writeFileSync(\'unexpected-hook\',\'bad\')"' },
		contributes: { viewsContainers: { activitybar: [{ id: 'lighthouse', title: `Lighthouse: Local Code Review (${version})` }] } },
		preserved: { value: 'keep' },
	};
	const lock = { name: 'lighthouse', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'lighthouse', version } } };
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
	fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
	return { root, manifest, lock };
}

test('new builds roll to the local calendar date and advance same-day revisions exactly once', () => {
	assert.equal(nextVersion('2026.1019.7', today), '2026.1020.1');
	assert.equal(nextVersion('2026.1020.1', today), '2026.1020.2');
	assert.equal(nextVersion('2026.1231.9', new Date(2027, 0, 2, 12)), '2027.102.1');
	assert.equal(nextVersion('2024.229.2', new Date(2024, 2, 1, 12)), '2024.301.1');
	assert.throws(() => nextVersion('2026.1021.1', today), /future-dated/);
	for (const version of ['2026.1032.1', '2026.1020.0', '2026.0102.1', '2026.1020.1-dev', '2026.10.20.1', '2025.229.1']) {
		assert.throws(() => calendarParts(version));
	}
});

test('packaging rejects yesterday and split metadata without changing files; checks never increment a prepared build', (t) => {
	const f = fixture(t);
	const original = fs.readFileSync(path.join(f.root, 'package.json'), 'utf8');
	assert.throws(() => checkVersion(f.root, today), /Stale build version/);
	assert.equal(checkVersion(f.root, today, false), '2026.1019.7');
	assert.equal(fs.readFileSync(path.join(f.root, 'package.json'), 'utf8'), original);
	const ready = fixture(t, '2026.1020.1');
	assert.equal(checkVersion(ready.root, today), '2026.1020.1');
	assert.equal(checkVersion(ready.root, today), '2026.1020.1');
	ready.lock.packages[''].version = '2026.1019.7';
	fs.writeFileSync(path.join(ready.root, 'package-lock.json'), JSON.stringify(ready.lock));
	assert.throws(() => checkVersion(ready.root, today), /metadata is inconsistent/);
	ready.lock.packages[''].version = '2026.1020.1';
	fs.writeFileSync(path.join(ready.root, 'package-lock.json'), JSON.stringify(ready.lock));
	ready.manifest.contributes.viewsContainers.activitybar[0].title = 'Lighthouse: Local Code Review (2026.1019.7)';
	fs.writeFileSync(path.join(ready.root, 'package.json'), JSON.stringify(ready.manifest));
	assert.throws(() => checkVersion(ready.root, today), /metadata is inconsistent/);
});

test('preparation uses npm to synchronize both lock fields and the header, without hooks, dependencies or Git state changes', (t) => {
	const f = fixture(t);
	let npmCli = process.env.npm_execpath;
	if (!npmCli) {
		npmCli = process.platform === 'win32'
			? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
			: fs.realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim());
	}
	assert.equal(prepareVersion(f.root, today, npmCli), '2026.1020.1');
	const manifest = JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'), 'utf8'));
	const lock = JSON.parse(fs.readFileSync(path.join(f.root, 'package-lock.json'), 'utf8'));
	assert.equal(manifest.version, '2026.1020.1');
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.packages[''].version, manifest.version);
	assert.equal(manifest.contributes.viewsContainers.activitybar[0].title, 'Lighthouse: Local Code Review (2026.1020.1)');
	assert.deepEqual(manifest.preserved, { value: 'keep' });
	assert.equal(fs.existsSync(path.join(f.root, 'unexpected-hook')), false);
	assert.equal(fs.existsSync(path.join(f.root, '.git')), false);
	assert.equal(fs.existsSync(path.join(f.root, 'node_modules')), false);
	assert.equal(prepareVersion(f.root, today, npmCli), '2026.1020.2');
});
