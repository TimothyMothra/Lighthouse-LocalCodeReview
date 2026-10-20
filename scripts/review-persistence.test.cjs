const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { atomicReviewWrite, nodeReviewIO, updateReviewFile, withReviewFileLock } = require('../out/reviewPersistence');
const { addReply } = require('../out/reviewCore');
const { review } = require('./mcp-fixture.cjs');

async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighthouse-persistence-'));
	const file = path.join(root, 'comments.json');
	await fs.writeFile(file, JSON.stringify(review()), { mode: 0o600 });
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return { root, file };
}

test('failed atomic replacement preserves original bytes, cleans its own temporary file, and releases the lock', async (t) => {
	const f = await fixture(t), original = await fs.readFile(f.file, 'utf8');
	await assert.rejects(updateReviewFile(f.file, (value) => addReply(value, 't-1', undefined, 'not committed', { kind: 'agent', name: 'Copilot' }), {
		io: { ...nodeReviewIO, rename: async () => { throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' }); } },
	}), /synthetic disk failure/);
	assert.equal(await fs.readFile(f.file, 'utf8'), original);
	assert.deepEqual(await fs.readdir(f.root), ['comments.json']);
	await updateReviewFile(f.file, (value) => addReply(value, 't-1', undefined, 'committed', { kind: 'agent', name: 'Copilot' }));
	assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).threads[0].comments.at(-1).body, 'committed');
	if (process.platform !== 'win32') { assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600); }
});

test('a held cross-process lock times out explicitly rather than silently overwriting the review', async (t) => {
	const f = await fixture(t), original = await fs.readFile(f.file, 'utf8');
	let release, acquired;
	const started = new Promise((resolve) => { acquired = resolve; });
	const holding = withReviewFileLock(f.file, async () => { acquired(); await new Promise((resolve) => { release = resolve; }); });
	await started;
	try {
		await assert.rejects(updateReviewFile(f.file, (value) => { value.targetBranch = 'must not save'; }), { code: 'ELOCKED' });
		assert.equal(await fs.readFile(f.file, 'utf8'), original);
	} finally { release(); await holding; }
});

test('atomic commits check observed external changes after staging, without deleting the external result', async (t) => {
	const f = await fixture(t);
	await assert.rejects(atomicReviewWrite(f.file, 'replacement', nodeReviewIO, async () => {
		await fs.writeFile(f.file, 'external writer');
		throw new Error('observed conflict');
	}), /observed conflict/);
	assert.equal(await fs.readFile(f.file, 'utf8'), 'external writer');
	assert.deepEqual(await fs.readdir(f.root), ['comments.json']);
});

test('lost lock ownership poisons the transaction before commit and never releases another owner lock', async (t) => {
	const f = await fixture(t), original = await fs.readFile(f.file, 'utf8');
	const filename = path.resolve(__dirname, '..', 'out', 'reviewPersistence.js'), nativeRequire = createRequire(filename);
	const module = { exports: {} };
	let compromise, released = false;
	vm.runInThisContext(wrap(await fs.readFile(filename, 'utf8')), { filename })(
		module.exports,
		(id) => id === 'proper-lockfile' ? { lock: async (_file, options) => {
			compromise = options.onCompromised;
			return async () => { released = true; };
		} } : nativeRequire(id),
		module, filename, path.dirname(filename),
	);
	await assert.rejects(module.exports.updateReviewFile(f.file, (value) => {
		value.targetBranch = 'not committed';
		compromise(Object.assign(new Error('synthetic lost ownership'), { code: 'ECOMPROMISED' }));
	}), { code: 'ECOMPROMISED' });
	assert.equal(await fs.readFile(f.file, 'utf8'), original);
	assert.equal(released, false);
	assert.deepEqual(await fs.readdir(f.root), ['comments.json']);
});
