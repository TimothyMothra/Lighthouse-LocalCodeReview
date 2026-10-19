const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire, wrap } = require('node:module');
const { GitMetadataCache } = require('../out/gitMetadataCache');
const diagnostics = require('../out/diagnostics');

const A = '1'.repeat(40), B = '2'.repeat(40);
const entry = (oid = A) => ({ mode: '100644', type: 'blob', oid });
const repositoryKey = (root) => crypto.createHash('sha256')
	.update(process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)).digest('hex');

function mockedCache(overrides) {
	const filename = path.resolve(__dirname, '..', 'out', 'gitMetadataCache.js');
	const nativeRequire = createRequire(filename), module = { exports: {} };
	vm.runInThisContext(wrap(require('node:fs').readFileSync(filename, 'utf8')), { filename })(
		module.exports, (name) => name === 'fs' ? { promises: { ...fs, ...overrides } } : nativeRequire(name),
		module, filename, path.dirname(filename),
	);
	return module.exports.GitMetadataCache;
}

async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighthouse-metadata-'));
	const folder = path.join(root, '.vscode', 'lighthouse-reviews', 'feature_main');
	const file = path.join(folder, 'metadata-cache.json'), caches = [], logs = [], calls = [];
	t.after(async () => {
		for (const cache of caches) { cache.dispose(); }
		await Promise.all(caches.map((cache) => cache.flush()));
		await fs.rm(root, { recursive: true, force: true });
	});
	const query = async (cwd, commit, files) => {
		calls.push({ cwd, commit, files });
		return new Map(files.filter((name) => name !== 'absent.ts').map((name) => [name, entry(commit)]));
	};
	function create(options = {}) {
		const cache = new (options.Cache ?? GitMetadataCache)(
			options.root ?? root, options.file ?? file, options.query ?? query, (message) => logs.push(message),
		);
		caches.push(cache); return cache;
	}
	async function seed(value) {
		await fs.mkdir(folder, { recursive: true });
		await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
	}
	return { root, folder, file, caches, logs, calls, query, create, seed };
}

test('constructor and empty metadata requests perform no cache I/O or Git queries', async (t) => {
	const f = await fixture(t);
	let reads = 0;
	const cache = f.create({ Cache: mockedCache({ open: async () => { reads++; throw new Error('unexpected cache read'); } }) });
	await cache.entries(A, []);
	assert.equal(reads, 0);
	assert.equal(f.calls.length, 0);
	assert.deepEqual(await fs.readdir(f.root), []);
});

test('branch-local metadata survives a new instance, including explicit absence, without changing comments', async (t) => {
	const f = await fixture(t), first = f.create();
	await fs.mkdir(f.folder, { recursive: true });
	const comments = path.join(f.folder, 'comments.json');
	await fs.writeFile(comments, 'review data must remain byte-identical\n');
	const result = await first.entries(A, ['file.ts', 'absent.ts']);
	assert.deepEqual(result.get('file.ts'), entry());
	assert.equal(result.has('absent.ts'), true);
	assert.equal(result.get('absent.ts'), undefined);
	await first.flush();
	assert.equal(await fs.readFile(comments, 'utf8'), 'review data must remain byte-identical\n');
	const second = f.create({ query: async () => assert.fail('persisted metadata should avoid Git') });
	assert.deepEqual(await second.entries(A, ['file.ts', 'absent.ts']), result);
	assert.equal(f.calls.length, 1);
	const raw = JSON.parse(await fs.readFile(f.file, 'utf8'));
	assert.equal(raw.version, 1);
	assert.ok(!(await fs.readFile(f.file, 'utf8')).includes(f.root));
	assert.equal(raw.commits[0].files.find((row) => row.path === 'absent.ts').entry, null);
	assert.deepEqual((await fs.readdir(f.folder)).sort(), ['comments.json', 'metadata-cache.json']);
});

test('missing paths, new commits, branch folders and different repositories use fresh Git metadata', async (t) => {
	const f = await fixture(t), cache = f.create();
	await cache.entries(A, ['file.ts']); await cache.flush();
	await cache.entries(A, ['new.ts']);
	await cache.entries(B, ['file.ts']);
	assert.equal(f.calls.length, 3);
	const otherBranch = f.create({ file: path.join(f.root, 'other-review', 'metadata-cache.json') });
	await otherBranch.entries(A, ['file.ts']);
	assert.equal(f.calls.length, 4);
	const otherRepository = f.create({ root: path.join(f.root, 'another-repository') });
	await otherRepository.entries(A, ['file.ts']);
	assert.equal(f.calls.length, 5);
	assert.equal(f.calls.at(-1).cwd, path.join(f.root, 'another-repository'));
});

test('malformed or unsupported cache data is rejected completely and rebuilt from Git', async (t) => {
	const f = await fixture(t);
	const valid = { version: 1, repository: repositoryKey(f.root), commits: [{ commit: A, files: [{ path: 'file.ts', entry: entry(B) }] }] };
	const invalid = [
		'not JSON',
		{ ...valid, version: 2 },
		{ ...valid, commits: [{ commit: A, files: [{ path: 'file.ts', entry: entry(B) }, { path: 'bad.ts', entry: { oid: 'invalid' } }] }] },
		{ ...valid, commits: [{ commit: A, files: [{ path: '../outside', entry: entry() }] }] },
		{ ...valid, commits: [valid.commits[0], valid.commits[0]] },
		{ ...valid, commits: [{ commit: A, files: [valid.commits[0].files[0], valid.commits[0].files[0]] }] },
		{ ...valid, commits: [1, 2, 3, 4, 5].map((n) => ({ commit: String(n).repeat(40), files: [] })) },
	];
	for (const document of invalid) {
		await f.seed(document);
		const before = f.calls.length, cache = f.create();
		assert.deepEqual((await cache.entries(A, ['file.ts'])).get('file.ts'), entry());
		assert.equal(f.calls.length, before + 1);
		await cache.flush();
	}
	assert.equal(f.logs.length, invalid.length);
});

test('oversized cache files are bounded on read and fall back to Git', async (t) => {
	const f = await fixture(t);
	await f.seed('x'.repeat(4 * 1024 * 1024 + 1));
	const cache = f.create();
	assert.deepEqual((await cache.entries(A, ['file.ts'])).get('file.ts'), entry());
	assert.equal(f.calls.length, 1);
	assert.equal(f.logs.length, 1);
	await cache.flush();
	assert.ok((await fs.stat(f.file)).size < 4 * 1024 * 1024);
});

test('read failures are diagnosed but do not prevent authoritative Git results', async (t) => {
	const f = await fixture(t);
	const cache = f.create({ Cache: mockedCache({
		open: async () => { throw Object.assign(new Error('private cache path'), { code: 'EACCES' }); },
	}) });
	assert.deepEqual((await cache.entries(A, ['file.ts'])).get('file.ts'), entry());
	await cache.entries(A, ['other.ts']);
	assert.equal(f.logs.length, 1);
	assert.match(f.logs[0], /load failed.*EACCES/);
	assert.ok(!f.logs[0].includes('private cache path'));
});

test('atomic write failures preserve an existing cache and comments, clean up temporary files, and keep memory results', async (t) => {
	const f = await fixture(t);
	const existing = JSON.stringify({ version: 1, repository: repositoryKey(f.root), commits: [] });
	await f.seed(existing);
	await fs.writeFile(path.join(f.folder, 'comments.json'), 'keep comments');
	const cache = f.create({ Cache: mockedCache({
		rename: async () => { throw Object.assign(new Error('private rename message'), { code: 'EACCES' }); },
	}) });
	await cache.entries(A, ['file.ts']); await cache.flush();
	assert.equal(await fs.readFile(f.file, 'utf8'), existing);
	assert.equal(await fs.readFile(path.join(f.folder, 'comments.json'), 'utf8'), 'keep comments');
	assert.deepEqual((await fs.readdir(f.folder)).sort(), ['comments.json', 'metadata-cache.json']);
	assert.deepEqual((await cache.entries(A, ['file.ts'])).get('file.ts'), entry());
	assert.equal(f.calls.length, 1);
	assert.ok(f.logs.some((message) => /write failed.*EACCES/.test(message)));
});

test('a failed Git query is never retained as a successful absent entry', async (t) => {
	const f = await fixture(t);
	let fail = true;
	const cache = f.create({ query: async (...args) => {
		if (fail) { throw Object.assign(new Error('Git unavailable'), { code: 128 }); }
		return f.query(...args);
	} });
	await assert.rejects(cache.entries(A, ['file.ts']), /Git unavailable/);
	await cache.flush();
	await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
	fail = false;
	assert.deepEqual((await cache.entries(A, ['file.ts'])).get('file.ts'), entry());
});

test('commit cache eviction is bounded to four slots and retains recently used commits', async (t) => {
	const f = await fixture(t), cache = f.create(), ids = [1, 2, 3, 4, 5].map((n) => String(n).repeat(40));
	for (const commit of ids.slice(0, 4)) { await cache.entries(commit, ['file.ts']); }
	await cache.entries(ids[0], ['file.ts']);
	await cache.entries(ids[4], ['file.ts']); await cache.flush();
	const persisted = JSON.parse(await fs.readFile(f.file, 'utf8'));
	assert.equal(persisted.commits.length, 4);
	assert.equal(persisted.commits.some((row) => row.commit === ids[1]), false);
	const reload = f.create(), count = f.calls.length;
	await reload.entries(ids[0], ['file.ts']); assert.equal(f.calls.length, count);
	await reload.entries(ids[1], ['file.ts']); assert.equal(f.calls.length, count + 1);
});

test('byte-limit eviction shrinks the cache without dropping results from the active lookup', async (t) => {
	const f = await fixture(t), cache = f.create();
	const files = Array.from({ length: 12000 }, (_, index) => `${index}-${'x'.repeat(300)}.ts`);
	const result = await cache.entries(A, files);
	assert.equal(result.size, files.length);
	await cache.flush();
	assert.ok((await fs.stat(f.file)).size <= 4 * 1024 * 1024);
	const persisted = JSON.parse(await fs.readFile(f.file, 'utf8'));
	assert.ok(persisted.commits[0].files.length < files.length);
	assert.deepEqual(result.get(files[0]), entry());
});

test('concurrent misses may duplicate Git queries but their completed updates and writes remain valid', async (t) => {
	const f = await fixture(t), releases = [], cache = f.create({
		query: async (_root, commit, files) => {
			await new Promise((resolve) => releases.push(resolve));
			return new Map(files.map((file) => [file, entry(commit)]));
		},
	});
	const first = cache.entries(A, ['file.ts']), second = cache.entries(A, ['file.ts']);
	while (releases.length < 2) { await new Promise(setImmediate); }
	for (const release of releases) { release(); }
	assert.deepEqual(await first, await second);
	await cache.flush();
	assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).commits[0].files.length, 1);
});

test('metadata added during an atomic write is included before waiting flushes complete', async (t) => {
	const f = await fixture(t);
	let release, started, first = true, writes = 0, peakWrites = 0;
	const gate = new Promise((resolve) => { release = resolve; });
	const start = new Promise((resolve) => { started = resolve; });
	const cache = f.create({ Cache: mockedCache({
		rename: async (...args) => {
			writes++; peakWrites = Math.max(peakWrites, writes);
			try {
				if (first) { first = false; started(); await gate; }
				return await fs.rename(...args);
			} finally { writes--; }
		},
	}) });
	await cache.entries(A, ['first.ts']);
	const flushing = cache.flush(); await start;
	await cache.entries(B, ['second.ts']);
	const waiting = cache.flush();
	release(); await Promise.all([flushing, waiting]);
	const document = JSON.parse(await fs.readFile(f.file, 'utf8'));
	assert.equal(document.commits.length, 2);
	assert.equal(peakWrites, 1);
	assert.deepEqual(await fs.readdir(f.folder), ['metadata-cache.json']);
});

test('concurrent eviction cannot turn an already captured cache hit into apparent absence', async (t) => {
	const f = await fixture(t);
	let release, started;
	const gate = new Promise((resolve) => { release = resolve; });
	const start = new Promise((resolve) => { started = resolve; });
	const cache = f.create({ query: async (_root, commit, files) => {
		if (commit === A && files.includes('new.ts')) { started(); await gate; }
		return new Map(files.map((file) => [file, entry(commit)]));
	} });
	await cache.entries(A, ['cached.ts']);
	const pending = cache.entries(A, ['cached.ts', 'new.ts']); await start;
	for (const id of ['2', '3', '4', '5']) { await cache.entries(id.repeat(40), ['other.ts']); }
	release();
	const result = await pending;
	assert.deepEqual(result.get('cached.ts'), entry());
	assert.deepEqual(result.get('new.ts'), entry());
});

test('metadata-cache diagnostics omit repository paths, filenames, IDs and raw errors', async (t) => {
	diagnostics.startDiagnostics(diagnostics.now(), true, () => {}, {});
	t.after(() => diagnostics.setDiagnosticsEnabled(false));
	const f = await fixture(t), cache = f.create();
	await cache.entries(A, ['private-file.ts']); await cache.flush();
	const reload = f.create(); await reload.entries(A, ['private-file.ts']);
	const serialized = JSON.stringify(diagnostics.diagnosticsSnapshot());
	for (const privateValue of [f.root, 'private-file.ts', A]) { assert.ok(!serialized.includes(privateValue)); }
	assert.ok(serialized.includes('reviewed.metadataCacheLoaded'));
	assert.ok(serialized.includes('reviewed.metadataCacheWritten'));
});
