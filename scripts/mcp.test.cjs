const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { fixture, repository, review, connect } = require('./mcp-fixture.cjs');

test('stdio tools read saved reviews without writes and expose exact first-comment Unicode previews', async (t) => {
	const bodies = ['', 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), '😀'.repeat(65), '# Heading\n' + 'z'.repeat(70)];
	const f = await fixture(t, review(bodies.map((body, index) => ({
		id: `t-${index}`, seq: index + 1, tags: [], comments: [{ id: `c-${index}`, body }, { id: `r-${index}`, body: 'Not the preview' }],
	}))));
	const original = await fs.readFile(f.file, 'utf8'), stat = await fs.stat(f.file);
	const tools = await f.client.listTools();
	assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['get_review', 'get_thread', 'list_reviews', 'reply_to_thread']);
	assert.equal(tools.tools.find((tool) => tool.name === 'reply_to_thread').annotations.readOnlyHint, false);
	const listed = await f.call('list_reviews');
	assert.equal(listed.data.items[0].reviewId, f.id);
	const index = await f.call('get_review', { reviewId: f.id });
	for (let i = 0; i < bodies.length; i++) {
		assert.equal(index.data.items[i].initialCommentPreview, Array.from(bodies[i]).slice(0, 64).join(''));
		assert.equal(index.data.items[i].initialCommentPreviewTruncated, Array.from(bodies[i]).length > 64);
		assert.equal(index.data.items[i].commentCount, 2);
		assert.ok(!Object.hasOwn(index.data.items[i], 'comments'));
	}
	assert.equal(index.data.workspaceRoot.toLowerCase(), f.root.toLowerCase());
	const first = await f.call('get_thread', { reviewId: f.id, threadId: 't-5', limit: 1 });
	assert.equal(first.data.items[0].body, bodies[5]);
	const next = await f.call('get_thread', { reviewId: f.id, threadId: 't-5', limit: 1, cursor: first.data.nextCursor });
	assert.equal(next.data.items[0].body, 'Not the preview');
	assert.equal((await fs.stat(f.file)).mtimeMs, stat.mtimeMs);
	assert.equal(await fs.readFile(f.file, 'utf8'), original);
	await fs.writeFile(f.file, original + ' ');
	assert.equal((await f.call('get_thread', { reviewId: f.id, threadId: 't-5', cursor: first.data.nextCursor })).data.error.code, 'STALE_CURSOR');
	await fs.writeFile(f.file, original);
	assert.equal(await fs.readFile(f.file, 'utf8'), original);
	assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['comments.json']);
});

test('absent stores stay absent; malformed reviews and linked paths are explicit, not empty successes', async (t) => {
	const f = await fixture(t, null);
	assert.deepEqual((await f.call('list_reviews')).data.items, []);
	await assert.rejects(fs.stat(path.join(f.root, '.vscode')), { code: 'ENOENT' });
	await fs.mkdir(path.dirname(f.file), { recursive: true });
	await fs.writeFile(f.file, '{"version":3,"threads":[]}');
	const listed = await f.call('list_reviews');
	assert.equal(listed.data.complete, false);
	assert.deepEqual(listed.data.issues, [{ reviewId: f.id, code: 'INVALID_REVIEW' }]);
	assert.equal((await f.call('get_review', { reviewId: f.id })).data.error.code, 'INVALID_REVIEW');
	for (const id of ['../comments.json', '/comments.json', 'C:\\private\\comments.json']) {
		assert.equal((await f.call('get_review', { reviewId: id })).data.error.code, 'INVALID_REVIEW_ID');
	}
	assert.equal((await f.call('list_reviews', { workspace: '../outside' })).data.error.code, 'INVALID_WORKSPACE');
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lighthouse-mcp-outside-'));
	t.after(() => fs.rm(outside, { recursive: true, force: true }));
	await fs.symlink(outside, path.join(f.root, '.vscode', 'lighthouse-reviews', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
	assert.equal((await f.call('get_review', { reviewId: 'linked/comments.json' })).data.error.code, 'LINKED_REVIEW');
	assert.equal((await f.call('list_reviews', { workspace: '.vscode/lighthouse-reviews/linked' })).data.error.code, 'OUTSIDE_WORKTREE');
});

test('replies preserve unknown fields and checklist/state, deduplicate retries, and reject stale/conflicting requests', async (t) => {
	const original = review();
	original.reviewedFileSnapshots['file.ts'].futureSnapshot = 'preserve';
	original.reviewedFileSnapshots['file.ts'].right.futureSide = 'preserve';
	const f = await fixture(t, original);
	const thread = await f.call('get_thread', { reviewId: f.id, threadId: 't-1' });
	const input = {
		reviewId: f.id, threadId: 't-1', body: 'Here is the response.', expectedRevision: thread.data.revision,
		requestId: 'synthetic-request-1', author: { kind: 'agent', name: 'Copilot', model: 'Synthetic model', sessionId: 'synthetic-session' },
	};
	const response = await f.call('reply_to_thread', input);
	assert.ok(!response.isError, JSON.stringify(response.data));
	assert.equal(response.data.replayed, false);
	assert.equal(response.data.comment.replyTo, 'c-1');
	assert.ok(!Number.isNaN(Date.parse(response.data.comment.timestamp)));
	const after = JSON.parse(await fs.readFile(f.file, 'utf8'));
	assert.deepEqual(after.threads[0].comments[0], original.threads[0].comments[0]);
	assert.deepEqual(after.reviewedFileSnapshots, original.reviewedFileSnapshots);
	assert.equal(after.threads[0].state, 'resolved');
	assert.equal(after.seqCounter, 7);
	assert.equal(after.extraRoot.preserve, true);
	assert.equal(after.threads[0].extraThread, 'keep');
	assert.equal((await f.call('reply_to_thread', input)).data.replayed, true);
	assert.equal((await f.call('reply_to_thread', { ...input, body: 'Different reply' })).data.error.code, 'REQUEST_CONFLICT');
	assert.equal((await f.call('reply_to_thread', { ...input, requestId: 'new-request' })).data.error.code, 'REVISION_CONFLICT');
	const current = await f.call('get_thread', { reviewId: f.id, threadId: 't-1' });
	assert.equal((await f.call('reply_to_thread', { ...input, requestId: 'bad-parent', expectedRevision: current.data.revision, replyTo: 'other-thread-comment' })).data.error.code, 'INVALID_PARENT');
	const full = '😀'.repeat(16384);
	const boundary = await f.call('reply_to_thread', { ...input, requestId: 'boundary', body: full, expectedRevision: current.data.revision });
	assert.ok(!boundary.isError, JSON.stringify(boundary.data));
	assert.equal((await f.call('reply_to_thread', { ...input, requestId: 'oversized', body: full + 'x', expectedRevision: boundary.data.revision })).data.error.code, 'INVALID_BODY');
	assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).threads[0].comments.length, 3);
});

test('a reply cannot push the serialized review over its read limit', async (t) => {
	const maximum = 16 * 1024 * 1024, data = review();
	data.extraRoot.padding = '';
	const overhead = Buffer.byteLength(JSON.stringify(data, null, 2) + '\n', 'utf8');
	data.extraRoot.padding = 'é'.repeat(Math.floor((maximum - 1024 - overhead) / 2));
	const f = await fixture(t, data), original = await fs.readFile(f.file, 'utf8');
	assert.ok(Buffer.byteLength(original, 'utf8') <= maximum - 1024);
	assert.ok(Buffer.byteLength(original, 'utf8') >= maximum - 1025);
	const thread = await f.call('get_thread', { reviewId: f.id, threadId: 't-1' });
	const input = {
		reviewId: f.id, threadId: 't-1', expectedRevision: thread.data.revision,
		requestId: 'review-size-rejected', body: '😀'.repeat(1024), author: { kind: 'agent', name: 'Copilot' },
	};
	const rejected = await f.call('reply_to_thread', input);
	assert.equal(rejected.data.error.code, 'REVIEW_TOO_LARGE');
	assert.ok(await fs.readFile(f.file, 'utf8') === original, 'An oversized reply must leave the saved review byte-identical.');
	assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['comments.json']);
	const accepted = await f.call('reply_to_thread', { ...input, requestId: 'review-size-fits', body: 'A short reply fits.' });
	assert.ok(!accepted.isError, JSON.stringify(accepted.data));
	assert.ok((await fs.stat(f.file)).size <= maximum);
	assert.equal((await f.call('get_thread', { reviewId: f.id, threadId: 't-1' })).data.commentCount, 2);
});

test('read pages honor the default and maximum bounds, reject bad limits, and never truncate large comments', async (t) => {
	const data = review(Array.from({ length: 201 }, (_, index) => ({
		id: `page-${index}`, tags: [], comments: [{ id: `body-${index}`, body: `${index}: hello` }],
	})));
	const f = await fixture(t, data);
	const first = await f.call('get_review', { reviewId: f.id });
	assert.equal(first.data.items.length, 50);
	assert.equal(first.data.total, 201);
	const largePage = await f.call('get_review', { reviewId: f.id, limit: 200 });
	assert.equal(largePage.data.items.length, 200);
	const last = await f.call('get_review', { reviewId: f.id, limit: 200, cursor: largePage.data.nextCursor });
	assert.equal(last.data.items.length, 1);
	for (const limit of [0, 201]) {
		await f.client.callTool({ name: 'get_review', arguments: { reviewId: f.id, limit } }).then(
			(result) => assert.equal(result.isError, true),
			(error) => assert.equal(error.code, -32602),
		);
	}
	data.threads[0].comments[0].body = 'x'.repeat(1024 * 1024);
	await fs.writeFile(f.file, JSON.stringify(data));
	assert.equal((await f.call('get_thread', { reviewId: f.id, threadId: 'page-0', limit: 1 })).data.error.code, 'RESULT_TOO_LARGE');
});

test('legacy snapshots are readable but cannot be written, while supported v1 identities upgrade without loss', async (t) => {
	const data = { threads: [{ comments: [{ body: 'legacy', author: 'reviewer' }] }] };
	const f = await fixture(t, data);
	const original = await fs.readFile(f.file, 'utf8');
	const index = await f.call('get_review', { reviewId: f.id });
	const id = index.data.items[0].threadId;
	assert.equal(index.data.items[0].writable, false);
	const thread = await f.call('get_thread', { reviewId: f.id, threadId: id });
	assert.equal(thread.data.items[0].author.name, 'reviewer');
	assert.equal((await f.call('reply_to_thread', {
		reviewId: f.id, threadId: id, body: 'answer', requestId: 'legacy',
		expectedRevision: thread.data.revision, author: { kind: 'agent', name: 'Copilot' },
	})).data.error.code, 'LEGACY_READ_ONLY');
	assert.equal(await fs.readFile(f.file, 'utf8'), original);
	data.threads[0].id = 'stable'; data.threads[0].comments[0].id = 'stable-comment';
	await fs.writeFile(f.file, JSON.stringify(data));
	const ready = await f.call('get_thread', { reviewId: f.id, threadId: 'stable' });
	assert.ok(!(await f.call('reply_to_thread', {
		reviewId: f.id, threadId: 'stable', body: 'answer', requestId: 'upgrade',
		expectedRevision: ready.data.revision, author: { kind: 'agent', name: 'Copilot' },
	})).isError);
	assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).version, 2);
});

test('worktree launch scope is isolated, including linked worktree metadata and nested workspace stores', async (t) => {
	const f = await fixture(t);
	const other = await fs.mkdtemp(path.join(os.tmpdir(), 'lighthouse-mcp-worktree-'));
	t.after(() => fs.rm(other, { recursive: true, force: true }));
	const metadata = path.join(f.root, '.git', 'worktrees', 'other');
	await fs.mkdir(metadata, { recursive: true });
	await fs.writeFile(path.join(other, '.git'), `gitdir: ${metadata}\n`);
	await fs.writeFile(path.join(metadata, 'HEAD'), 'ref: refs/heads/other\n');
	await fs.writeFile(path.join(metadata, 'commondir'), '../..\n');
	await fs.writeFile(path.join(metadata, 'gitdir'), path.join(other, '.git') + '\n');
	const connected = await connect(other);
	try {
		const result = await connected.call('list_reviews');
		assert.deepEqual(result.data.items, []);
		assert.equal(result.data.workspaceRoot.toLowerCase(), other.toLowerCase());
	} finally { await connected.client.close(); }
	const nested = path.join(f.root, 'nested', '.vscode', 'lighthouse-reviews', 'nested', 'comments.json');
	await fs.mkdir(path.dirname(nested), { recursive: true });
	await fs.writeFile(nested, JSON.stringify(review()));
	assert.equal((await f.call('list_reviews', { workspace: 'nested' })).data.items[0].reviewId, 'nested/comments.json');
	const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'lighthouse-mcp-nogit-'));
	t.after(() => fs.rm(empty, { recursive: true, force: true }));
	const noGit = await connect(empty);
	try { assert.equal((await noGit.call('list_reviews')).data.error.code, 'NO_WORKTREE'); }
	finally { await noGit.client.close(); }
});

test('a separate UI-equivalent writer and MCP reply cannot overwrite each other', async (t) => {
	const f = await fixture(t);
	const before = await f.call('get_thread', { reviewId: f.id, threadId: 't-1' });
	const worker = fork(path.join(__dirname, 'mcp-write-worker.cjs'), [f.file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
	t.after(() => { if (!worker.killed && worker.exitCode === null) { worker.kill(); } });
	await once(worker, 'message');
	const input = {
		reviewId: f.id, threadId: 't-1', body: 'MCP response', requestId: 'concurrent',
		expectedRevision: before.data.revision, author: { kind: 'agent', name: 'Copilot' },
	};
	const pending = f.call('reply_to_thread', input);
	worker.send('release');
	await once(worker, 'exit');
	const response = await pending;
	assert.equal(response.data.error.code, 'REVISION_CONFLICT');
	const fresh = await f.call('get_thread', { reviewId: f.id, threadId: 't-1' });
	assert.ok(!(await f.call('reply_to_thread', { ...input, expectedRevision: fresh.data.revision })).isError);
	const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
	assert.deepEqual(saved.reviewedFiles ?? [], []);
	assert.deepEqual(saved.threads[0].comments.map((comment) => comment.body), ['Explain this design.', 'Human follow-up', 'MCP response']);
});

test('MCP reports a held write lock explicitly without claiming that a reply was saved', async (t) => {
	const f = await fixture(t);
	const thread = await f.call('get_thread', { reviewId: f.id, threadId: 't-1' });
	const worker = fork(path.join(__dirname, 'mcp-write-worker.cjs'), [f.file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
	t.after(() => { if (!worker.killed && worker.exitCode === null) { worker.kill(); } });
	await once(worker, 'message');
	try {
		const result = await f.call('reply_to_thread', {
			reviewId: f.id, threadId: 't-1', body: 'must not be saved', requestId: 'locked-request',
			expectedRevision: thread.data.revision, author: { kind: 'agent', name: 'Copilot' },
		});
		assert.equal(result.isError, true);
		assert.equal(result.data.error.code, 'ELOCKED');
		assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).threads[0].comments.length, 1);
	} finally { worker.send('release'); await once(worker, 'exit'); }
});
