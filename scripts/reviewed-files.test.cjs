const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const model = require('../out/reviewModel');
const git = require('../out/git');
const diagnostics = require('../out/diagnostics');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const A = '1'.repeat(40), B = '2'.repeat(40), C = '3'.repeat(40);
const entry = (oid = A, mode = '100644') => ({ oid, mode, type: 'blob' });
const snapshot = (left = A, right = 'saved') => ({
	version: 1, left: { kind: 'file', hash: left, mode: '100644' },
	right: { kind: 'file', hash: sha(right), mode: '100644' },
});

function load(name, mocks) {
	const filename = path.resolve(__dirname, '..', 'out', `${name}.js`);
	const module = { exports: {} }, nativeRequire = createRequire(filename);
	vm.runInThisContext(wrap(require('node:fs').readFileSync(filename, 'utf8')), { filename })(
		module.exports, (id) => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id),
		module, filename, path.dirname(filename),
	);
	return module.exports;
}

async function fixture(t, initial = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'searchlight-reviewed-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const uri = (fsPath) => ({ fsPath, scheme: 'file', toString: () => `file:${fsPath}` });
	const handlers = { save: new Set(), change: new Set(), close: new Set() }, watchers = new Set();
	const warnings = [], info = [], logs = [], writes = [];
	const event = (kind) => (handler) => { handlers[kind].add(handler); return { dispose: () => handlers[kind].delete(handler) }; };
	const vscode = {
		Uri: { file: uri },
		RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
		window: { showWarningMessage: (text) => warnings.push(text), showInformationMessage: (text) => info.push(text) },
		workspace: {
			textDocuments: [],
			onDidSaveTextDocument: event('save'), onDidChangeTextDocument: event('change'), onDidCloseTextDocument: event('close'),
			createFileSystemWatcher(pattern) {
				const callbacks = [];
				const watcher = {
					pattern, onDidChange: (f) => callbacks.push(f), onDidCreate: (f) => callbacks.push(f), onDidDelete: (f) => callbacks.push(f),
					fire: (value) => callbacks[0](value),
					dispose: () => watchers.delete(watcher),
				};
				watchers.add(watcher); return watcher;
			},
			fs: {
				readFile: (value) => fs.readFile(value.fsPath),
				createDirectory: (value) => fs.mkdir(value.fsPath, { recursive: true }),
				writeFile: async (value, bytes) => { writes.push(value.fsPath); await fs.writeFile(value.fsPath, bytes); },
			},
		},
	};
	const tables = new Map([[A, new Map([['file.ts', entry()]])], [B, new Map([['file.ts', entry(B)]])]]);
	const calls = { trees: 0, blobs: 0, hashes: 0, availability: 0 };
	const gitMock = {
		readGitFileEntries: async (_root, commit, files) => {
			calls.trees++;
			assert.ok(tables.has(commit), `unknown commit ${commit}`);
			return new Map(files.filter((file) => tables.get(commit).has(file)).map((file) => [file, tables.get(commit).get(file)]));
		},
		runGitQuery: async () => 'false',
		hashGitBlob: async (_root, oid) => { calls.blobs++; return sha(oid === B ? 'saved' : 'baseline'); },
	};
	const store = load('reviewStore', { vscode });
	const exports = load('reviewedFiles', { vscode, './reviewStore': store, './git': gitMock });
	const review = { ...store.emptyReview(root, 'feature', 'main', B, A), ...initial };
	const active = {
		repoRootFsPath: root, sourceFile: review.sourceFile, baselineCommit: A, compareCommit: B, compareIsHead: true, review,
		async reloadReview() {
			const file = this.sourceFile, loaded = await store.loadReview(uri(file));
			if (file === this.sourceFile && loaded) { this.review = loaded; }
		},
	};
	await fs.writeFile(path.join(root, 'file.ts'), 'saved');
	if (initial.persisted) {
		await store.saveReview(review); writes.length = 0;
	}
	const coordinator = new exports.ReviewedFiles(() => active, () => calls.availability++, (message) => logs.push(message));
	const hashSaved = coordinator.reader.savedSide.bind(coordinator.reader);
	coordinator.reader.savedSide = async (...args) => { calls.hashes++; return hashSaved(...args); };
	t.after(() => coordinator.dispose());
	coordinator.reconcile('startup');
	async function flush() {
		if (coordinator.timer) { clearTimeout(coordinator.timer); coordinator.timer = undefined; }
		await coordinator.drain();
	}
	const document = { uri: uri(path.join(root, 'file.ts')), isDirty: false };
	function dirty(value) { document.isDirty = value; for (const handler of handlers.change) { handler({ document }); } }
	function save() { document.isDirty = false; for (const handler of handlers.save) { handler(document); } }
	function external(file = 'file.ts') { for (const watcher of [...watchers]) { watcher.fire(uri(path.join(root, file))); } }
	return { root, active, coordinator, exports, store, vscode, handlers, watchers, warnings, info, logs, writes, calls, tables, uri, flush, dirty, save, external, document };
}

test('fingerprints round-trip without changing discussions, and malformed snapshots cannot certify legacy checks', async (t) => {
	const f = await fixture(t);
	const original = {
		version: 1, reviewedFiles: ['file.ts', 'old.ts', 'bad.ts'], seqCounter: 9,
		reviewedFileSnapshots: { 'file.ts': snapshot(), 'bad.ts': { ...snapshot(), version: 2 } },
		threads: [{ id: 'thread', seq: 9, comments: [{ body: 'keep', author: 'human' }] }],
	};
	const review = model.parseReview(JSON.stringify(original), f.active.sourceFile);
	assert.equal(model.clearLegacyReviewedFiles(review), 2);
	assert.deepEqual(review.reviewedFiles, ['file.ts']);
	const serialized = f.store.serializeReview(review);
	assert.equal(serialized.version, 2);
	assert.equal(serialized.seqCounter, 9);
	assert.equal(serialized.threads[0].comments[0].body, 'keep');
	assert.deepEqual(serialized.reviewedFileSnapshots['file.ts'], snapshot());
	assert.ok(model.sameReviewedSnapshot(model.parseReview(JSON.stringify(serialized), review.sourceFile).reviewedFileSnapshots['file.ts'], snapshot()));
	model.setFileReviewed(review, 'file.ts');
	assert.ok(!Object.hasOwn(f.store.serializeReview(review), 'reviewedFileSnapshots'));
	assert.throws(() => model.setFileReviewed(review, '../outside', snapshot()), /Invalid/);
});

test('a save unchecks changed content, identical saves retain checks, and undo never rechecks', async (t) => {
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	assert.deepEqual(f.active.review.reviewedFiles, ['file.ts']);
	const trees = f.calls.trees;
	f.save(); await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, ['file.ts']);
	assert.equal(f.calls.trees, trees);
	await fs.writeFile(path.join(f.root, 'file.ts'), 'new content');
	f.save(); await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, []);
	assert.equal(f.active.review.reviewedFileSnapshots?.['file.ts'], undefined);
	await fs.writeFile(path.join(f.root, 'file.ts'), 'saved');
	f.save(); await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, []);
});

test('dirty editors disable both actions without hashing; discard restores availability', async (t) => {
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	const hashes = f.calls.hashes, trees = f.calls.trees;
	f.dirty(true);
	for (let i = 0; i < 30; i++) { f.dirty(true); }
	assert.equal(f.coordinator.availability('file.ts').dirty, true);
	await assert.rejects(f.coordinator.setReviewed('file.ts', false, f.coordinator.key), /Save or discard/);
	await assert.rejects(f.coordinator.setReviewed('file.ts', true, f.coordinator.key), /Save or discard/);
	assert.equal(f.calls.hashes, hashes);
	assert.equal(f.calls.trees, trees);
	assert.deepEqual(f.active.review.reviewedFiles, ['file.ts']);
	f.dirty(false);
	assert.equal(f.coordinator.availability('file.ts').dirty, false);
	assert.equal(f.calls.hashes, hashes);
});

test('unchecked files, comments, and ordinary redraws perform no fingerprint reads; duplicate events coalesce', async (t) => {
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	const before = f.calls.hashes, writes = f.writes.length;
	f.external('unchecked.ts');
	for (let i = 0; i < 20; i++) {
		f.coordinator.reconcile('review-changed');
		f.coordinator.reconcile('command-or-review-action');
	}
	await f.flush();
	assert.equal(f.calls.hashes, before);
	assert.equal(f.writes.length, writes);
	f.save(); f.external(); f.save();
	await f.flush();
	assert.equal(f.calls.hashes, before + 1);
});

test('Git hints use cheap metadata probes and still find a further edit in an already modified file', async (t) => {
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	const before = f.calls.hashes;
	f.coordinator.reconcile('git-api-state');
	await f.coordinator.savedHints(f.coordinator.context(), ['file.ts']);
	await f.flush();
	assert.equal(f.calls.hashes, before);
	await fs.writeFile(path.join(f.root, 'file.ts'), 'saved again without a direct source event');
	await f.coordinator.savedHints(f.coordinator.context(), ['file.ts']);
	await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, []);
	assert.equal(f.calls.hashes, before + 1);
});

test('already-dirty documents can be present before the Files provider exists', async (t) => {
	const f = await fixture(t);
	f.vscode.workspace.textDocuments = [{ uri: f.document.uri, isDirty: true }];
	let ready = false;
	const coordinator = new f.exports.ReviewedFiles(() => f.active, () => assert.ok(ready), () => {});
	ready = true;
	assert.equal(coordinator.availability('file.ts').dirty, true);
	coordinator.dispose();
});

test('legacy checks are cleared once without hashing or removing discussions', async (t) => {
	const f = await fixture(t, {
		persisted: true, reviewedFiles: ['file.ts', 'old.ts'],
		threads: [{ id: 'thread', seq: 1, tags: ['question'], comments: [{ id: 'comment', body: 'keep me' }] }],
	});
	await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, []);
	assert.equal(f.active.review.threads[0].comments[0].body, 'keep me');
	assert.equal(f.calls.hashes, 0);
	assert.equal(f.info.length, 1);
	const writes = f.writes.length;
	f.coordinator.reconcile('review-changed'); await f.flush();
	assert.equal(f.writes.length, writes);
	assert.equal(f.info.length, 1);
});

test('invalid legacy paths are removed without traversing outside the repository', async (t) => {
	const f = await fixture(t, { persisted: true, reviewedFiles: ['../outside'] });
	await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, []);
	assert.equal(f.calls.hashes, 0);
});

test('left-side content changes invalidate, but identical content at a new baseline stays reviewed without saved rehashing', async (t) => {
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	const hashes = f.calls.hashes;
	f.tables.set(C, new Map([['file.ts', entry()]]));
	f.active.baselineCommit = C;
	f.coordinator.reconcile('select-base'); await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, ['file.ts']);
	assert.equal(f.calls.hashes, hashes);
	f.tables.set('4'.repeat(40), new Map([['file.ts', entry('4'.repeat(40))]]));
	f.active.baselineCommit = '4'.repeat(40);
	f.coordinator.reconcile('select-base'); await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, []);
});

test('committing the same saved content and mode changes preserve or invalidate the appropriate file', async (t) => {
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	f.tables.set(C, new Map([['file.ts', entry(C)]]));
	f.active.compareCommit = C;
	f.coordinator.reconcile('git-api-state'); await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, ['file.ts']);
	f.tables.set('4'.repeat(40), new Map([['file.ts', entry(C, '100755')]]));
	f.active.compareCommit = '4'.repeat(40);
	f.coordinator.reconcile('git-api-state'); await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, []);
});

test('forced Refresh catches hidden changed files even when size and mtime are restored', async (t) => {
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	const file = path.join(f.root, 'file.ts'), before = await fs.stat(file);
	await fs.writeFile(file, 'other');
	await fs.utimes(file, before.atime, before.mtime);
	f.coordinator.reconcile('manual-refresh'); await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, []);
});

test('absent and empty are distinct and checked deletions remain watched for recreation', async (t) => {
	const f = await fixture(t);
	await fs.unlink(path.join(f.root, 'file.ts'));
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	assert.deepEqual(f.active.review.reviewedFileSnapshots['file.ts'].right, { kind: 'absent' });
	assert.equal(f.watchers.size, 1);
	await fs.writeFile(path.join(f.root, 'file.ts'), '');
	f.external(); await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, []);
});

test('saved binary hashing is streamed and a non-HEAD review uses immutable source bytes', async (t) => {
	const f = await fixture(t);
	const bytes = Buffer.alloc(2 * 1024 * 1024, 0xa5);
	await fs.writeFile(path.join(f.root, 'file.ts'), bytes);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	assert.equal(f.active.review.reviewedFileSnapshots['file.ts'].right.hash, sha(bytes));
	await f.coordinator.setReviewed('file.ts', false, f.coordinator.key);
	f.active.compareIsHead = false; f.coordinator.reconcile('select-compare');
	f.dirty(true);
	assert.equal(f.coordinator.availability('file.ts').dirty, false);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	assert.equal(f.active.review.reviewedFileSnapshots['file.ts'].right.hash, sha('saved'));
	assert.equal(f.watchers.size, 0);
	const blobs = f.calls.blobs;
	f.coordinator.reconcile('manual-refresh'); await f.flush();
	assert.equal(f.calls.blobs, blobs);
});

test('failed reads never become absence, and failed writes never claim successful invalidation', async (t) => {
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	const read = f.coordinator.reader.read.bind(f.coordinator.reader);
	f.coordinator.reader.read = async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
	f.save(); await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, ['file.ts']);
	assert.match(f.coordinator.availability('file.ts').error, /permission denied/);
	assert.ok(f.logs.length && f.warnings.length);
	f.coordinator.reader.read = read;
	await fs.writeFile(path.join(f.root, 'file.ts'), 'changed');
	f.vscode.workspace.fs.writeFile = async () => { throw new Error('write denied'); };
	f.coordinator.reconcile('manual-refresh'); await f.flush();
	assert.deepEqual(f.active.review.reviewedFiles, ['file.ts']);
	assert.match(f.coordinator.availability('file.ts').error, /write denied/);
});

test('a source save arriving during a hash schedules a trailing pass instead of losing the change', async (t) => {
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	const read = f.coordinator.reader.read.bind(f.coordinator.reader);
	let release, started;
	const gate = new Promise((resolve) => { release = resolve; });
	const start = new Promise((resolve) => { started = resolve; });
	let first = true;
	f.coordinator.reader.read = async (...args) => {
		const result = await read(...args);
		if (first) { first = false; started(); await gate; }
		return result;
	};
	f.save();
	const running = f.flush(); await start;
	await fs.writeFile(path.join(f.root, 'file.ts'), 'changed during validation');
	f.external(); release(); await running;
	assert.deepEqual(f.active.review.reviewedFiles, []);
});

test('dirty or comparison changes during checking cannot certify newer unseen content', async (t) => {
	const f = await fixture(t);
	const read = f.coordinator.reader.read.bind(f.coordinator.reader);
	f.coordinator.reader.read = async (...args) => { const value = await read(...args); f.dirty(true); return value; };
	await assert.rejects(f.coordinator.setReviewed('file.ts', true, f.coordinator.key), /Save or discard/);
	assert.equal(f.writes.length, 0);
	f.dirty(false);
	f.coordinator.reader.read = async (...args) => { const value = await read(...args); f.active.baselineCommit = C; return value; };
	await assert.rejects(f.coordinator.setReviewed('file.ts', true, f.coordinator.key), /file or comparison changed/i);
	assert.equal(f.writes.length, 0);
});

test('switching reviews while a check is in flight cannot write the new review or leak its error state', async (t) => {
	const f = await fixture(t);
	const read = f.coordinator.reader.read.bind(f.coordinator.reader);
	let release, started;
	const gate = new Promise((resolve) => { release = resolve; });
	const start = new Promise((resolve) => { started = resolve; });
	f.coordinator.reader.read = async (...args) => { const value = await read(...args); started(); await gate; return value; };
	const checking = f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	const rejected = assert.rejects(checking, /file or comparison changed/i);
	await start;
	f.active.sourceFile = path.join(f.root, '.vscode', 'searchlight-reviews', 'another_main', 'comments.json');
	f.active.review = { ...f.store.emptyReview(f.root, 'another', 'main', B, A), sourceFile: f.active.sourceFile };
	f.coordinator.reconcile('select-compare');
	release(); await rejected;
	assert.equal(f.writes.length, 0);
	assert.equal(f.coordinator.availability('file.ts').error, undefined);
	assert.equal(f.coordinator.availability('file.ts').pending, false);
});

test('shared mutation queues preserve replies during invalidation and reject observed external writes', async (t) => {
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	await Promise.all([
		f.store.updateReview(f.active.sourceFile, (review) => model.setFileReviewed(review, 'file.ts')),
		f.store.updateReview(f.active.sourceFile, (review) => f.store.addThread(review, undefined, undefined, undefined, 'new reply', { kind: 'human', name: 'reviewer' })),
	]);
	await f.active.reloadReview();
	assert.deepEqual(f.active.review.reviewedFiles, []);
	assert.equal(f.active.review.threads[0].comments[0].body, 'new reply');
	await assert.rejects(f.store.updateReview(f.active.sourceFile, async (review) => {
		review.reviewedFiles = ['file.ts'];
		await fs.writeFile(f.active.sourceFile, JSON.stringify({ version: 2, threads: [{ id: 'external', comments: [{ body: 'external reply' }] }] }));
	}), /changed while saving/);
	await f.active.reloadReview();
	assert.equal(f.active.review.threads[0].comments[0].body, 'external reply');
	await f.store.updateReview(f.active.sourceFile, (review) => { review.targetBranch = 'retry succeeds'; });
});

test('unsupported submodules are explicit and directory links cannot escape the repository', async (t) => {
	const f = await fixture(t);
	f.tables.get(A).set('file.ts', { mode: '160000', type: 'commit', oid: A });
	await assert.rejects(f.coordinator.setReviewed('file.ts', true, f.coordinator.key), /submodule/);
	assert.equal(f.writes.length, 0);
	f.tables.get(A).set('file.ts', entry());
	f.coordinator.reader.reset();
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'searchlight-reviewed-outside-'));
	t.after(() => fs.rm(outside, { recursive: true, force: true }));
	await fs.writeFile(path.join(outside, 'file.ts'), 'external');
	await fs.symlink(outside, path.join(f.root, 'linked'), 'junction');
	await assert.rejects(f.coordinator.setReviewed('linked/file.ts', true, f.coordinator.key), /outside the repository/);
});

test('literal NUL-safe Git queries and binary blob hashing read a disposable object database', async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'searchlight-reviewed-git-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const metadata = path.join(root, '.git');
	await fs.mkdir(path.join(metadata, 'objects'), { recursive: true });
	await fs.mkdir(path.join(metadata, 'refs'), { recursive: true });
	await fs.writeFile(path.join(metadata, 'HEAD'), 'ref: refs/heads/main\n');
	await fs.writeFile(path.join(metadata, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
	// ASSUMPTION: construct only temporary loose objects; all executed Git commands are queries.
	async function object(type, body) {
		const bytes = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
		const oid = crypto.createHash('sha1').update(bytes).digest('hex');
		const directory = path.join(metadata, 'objects', oid.slice(0, 2));
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(path.join(directory, oid.slice(2)), zlib.deflateSync(bytes));
		return oid;
	}
	const bytes = Buffer.from([0, 255, 10, 13, 1]), blob = await object('blob', bytes);
	const file = ' space [literal].ts ', newline = 'tab\tline\n.ts';
	const tree = await object('tree', Buffer.concat(
		[file, newline].map((name) => Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blob, 'hex')])),
	));
	const commit = await object('commit', Buffer.from(`tree ${tree}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\nfixture\n`));
	const entries = await git.readGitFileEntries(root, commit, [file, newline, 'missing.ts']);
	assert.equal(entries.get(file).oid, blob);
	assert.equal(entries.get(newline).oid, blob);
	assert.equal(entries.has('missing.ts'), false);
	assert.equal(await git.hashGitBlob(root, blob), sha(bytes));
	await assert.rejects(git.readGitFileEntries(root, A, [file]), /Command failed/);
	await assert.rejects(git.readGitFileEntries(root, commit, ['../outside']), /relative paths/);
});

test('real Files client disables both checkbox variants and exposes the unsaved explanation without repainting', () => {
	const { FilesWebviewProvider } = load('filesWebview', {
		vscode: {}, './reviewDiff': { DIFF_SCHEME: 'searchlight-diff' },
		'./webviewMetrics': { PaneMetrics: class {}, logBuild() {} },
	});
	const provider = new FilesWebviewProvider(() => undefined, {}, () => {}, {});
	const html = provider.html({ cspSource: 'fixture' }), script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
	class Element {
		constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.style = {}; this.dataset = {}; this.className = ''; this.attributes = {}; }
		appendChild(child) { this.children.push(child); return child; }
		addEventListener(name, handler) { this.handlers[name] = handler; }
		setAttribute(name, value) { this.attributes[name] = value; }
		querySelector(selector) { return this.children.find((child) => child.className === selector.slice(1)); }
		querySelectorAll() { return this.children; }
	}
	const rows = new Element('rows'), messages = [];
	let receive;
	const context = vm.createContext({
		document: { getElementById: () => rows, createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element('fragment') },
		window: { addEventListener: (_, callback) => { receive = callback; } },
		vscode: { postMessage: (message) => messages.push(message) }, reportRendered() {}, performance: { now: () => 0 },
	});
	vm.runInContext(script, context);
	vm.runInContext("reviewKey = 'scope';", context);
	const tree = { dirs: [], files: [
		{ relPath: 'saved.ts', name: 'saved.ts', reviewed: true, uncommitted: false, reviewState: { reviewed: true, dirty: true } },
		{ relPath: 'dirty.ts', name: 'dirty.ts', reviewed: false, uncommitted: true, reviewState: { reviewed: false, dirty: true } },
	] };
	context.tree = tree;
	rows.children = vm.runInContext('renderDir(tree, 0).children', context);
	for (const row of rows.children) {
		assert.equal(row.querySelector('.chk').disabled, true);
		assert.equal(row.querySelector('.review-note').textContent, 'Unsaved');
		assert.match(row.querySelector('.review-note').title, /Save or discard/);
		assert.equal(row.querySelector('.review-note').tabIndex, 0);
	}
	receive({ data: { type: 'reviewAvailability', reviewKey: 'wrong', values: { 'saved.ts': { dirty: false } } } });
	assert.equal(rows.children[0].querySelector('.chk').disabled, true);
	receive({ data: { type: 'reviewAvailability', reviewKey: 'scope', values: { 'saved.ts': { reviewed: true, dirty: false }, 'dirty.ts': { reviewed: false, dirty: false } } } });
	assert.equal(rows.children[0].querySelector('.chk').disabled, false);
	assert.equal(rows.children[0].querySelector('.chk').checked, true);
	const checkbox = rows.children[1].querySelector('.chk');
	checkbox.checked = true; checkbox.handlers.change();
	assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'setReviewed', relPath: 'dirty.ts', reviewed: true, reviewKey: 'scope' });
	assert.equal(checkbox.disabled, true);
});

test('reviewed diagnostics correlate triggers, coalescing, keep/clear decisions and timings without exported paths or hashes', async (t) => {
	diagnostics.startDiagnostics(diagnostics.now(), true, () => {}, { fixture: true });
	t.after(() => diagnostics.setDiagnosticsEnabled(false));
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	f.save(); await f.flush();
	f.tables.set(C, new Map([['file.ts', entry(C)]]));
	f.active.baselineCommit = C;
	f.coordinator.reconcile('select-base'); await f.flush();
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	await fs.writeFile(path.join(f.root, 'file.ts'), 'new saved bytes');
	f.save(); f.external(); await f.flush();
	f.dirty(true); f.dirty(false);
	const report = diagnostics.diagnosticsSnapshot();
	const events = report.records.filter((record) => record.kind === 'event');
	assert.ok(events.some((record) => record.name === 'reviewed.queued' && record.fields.trigger === 'save'));
	assert.ok(events.some((record) => record.name === 'reviewed.queued' && record.fields.coalesced));
	assert.ok(events.some((record) => record.name === 'reviewed.kept'));
	assert.ok(events.some((record) => record.name === 'reviewed.invalidated' && record.fields.leftChanged && !record.fields.rightChanged));
	assert.ok(events.some((record) => record.name === 'reviewed.invalidated' && !record.fields.leftChanged && record.fields.rightChanged));
	assert.ok(events.some((record) => record.name === 'reviewed.dirty' && record.fields.dirty));
	assert.ok(events.some((record) => record.name === 'reviewed.watches' && record.fields.pathCount === 1));
	assert.ok(events.some((record) => record.name === 'reviewed.passFinished' && record.fields.invalidated === 1 && record.fields.durationMs >= 0));
	const action = report.records.find((record) => record.name === 'reviewed.action' && record.kind === 'start');
	const capture = report.records.find((record) => record.name === 'reviewed.snapshot' && record.parentId === action.spanId);
	assert.equal(capture.fields.fileId, action.fields.fileId);
	assert.ok(report.aggregates['reviewed.snapshot'].count > 0);
	assert.ok(f.logs.some((line) => line.includes('fileId=') && line.includes('file.ts')));
	const serialized = JSON.stringify(report);
	for (const privateValue of [f.root, 'file.ts', A, B, C, sha('saved'), sha('new saved bytes'), 'new saved bytes']) {
		assert.ok(!serialized.includes(privateValue), `diagnostic export leaked ${privateValue}`);
	}
});

test('reviewed failures include safe error codes and precise stages; disabled diagnostics preserve behavior without trace output', async (t) => {
	diagnostics.startDiagnostics(diagnostics.now(), true, () => {}, {});
	t.after(() => diagnostics.setDiagnosticsEnabled(false));
	const f = await fixture(t);
	await f.coordinator.setReviewed('file.ts', true, f.coordinator.key);
	const read = f.coordinator.reader.read.bind(f.coordinator.reader);
	f.coordinator.reader.read = async () => { throw Object.assign(new Error('private-read-message'), { code: 'EACCES' }); };
	f.save(); await f.flush();
	let failure = diagnostics.diagnosticsSnapshot().records.find((record) => record.name === 'reviewed.failed');
	assert.equal(failure.fields.stage, 'snapshot');
	assert.equal(failure.fields.code, 'EACCES');
	assert.equal(typeof failure.fields.fileId, 'number');
	f.coordinator.reader.read = read;
	await fs.writeFile(path.join(f.root, 'file.ts'), 'changed');
	f.vscode.workspace.fs.writeFile = async () => { throw Object.assign(new Error('private-write-message'), { code: 'ENOSPC' }); };
	f.coordinator.reconcile('manual-refresh'); await f.flush();
	failure = diagnostics.diagnosticsSnapshot().records.filter((record) => record.name === 'reviewed.failed').at(-1);
	assert.equal(failure.fields.stage, 'persist');
	assert.equal(failure.fields.code, 'ENOSPC');
	const serialized = JSON.stringify(diagnostics.diagnosticsSnapshot());
	assert.ok(!serialized.includes('private-read-message') && !serialized.includes('private-write-message'));

	diagnostics.startDiagnostics(diagnostics.now(), false, () => assert.fail('disabled trace emitted output'), {});
	const quiet = await fixture(t);
	await quiet.coordinator.setReviewed('file.ts', true, quiet.coordinator.key);
	await fs.writeFile(path.join(quiet.root, 'file.ts'), 'changed without logging');
	quiet.save(); await quiet.flush();
	assert.deepEqual(quiet.active.review.reviewedFiles, []);
	assert.equal(diagnostics.diagnosticsSnapshot().records.length, 0);
	assert.ok(!quiet.logs.some((line) => line.startsWith('[reviewed]')));
});
