const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const server = path.resolve(__dirname, '..', 'out', 'mcp', 'server.cjs');

async function repository(root) {
	await fs.mkdir(path.join(root, '.git', 'objects'), { recursive: true });
	await fs.mkdir(path.join(root, '.git', 'refs'), { recursive: true });
	await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
	await fs.writeFile(path.join(root, '.git', 'config'), '[core]\nrepositoryformatversion=0\nbare=false\n');
}

function review(threads) {
	return {
		version: 2, sourceBranch: 'feature', targetBranch: 'main', seqCounter: 7,
		extraRoot: { preserve: true }, reviewedFiles: ['file.ts'],
		reviewedFileSnapshots: { 'file.ts': { version: 1, left: { kind: 'absent' }, right: { kind: 'file', hash: 'a'.repeat(64), mode: '100644' } } },
		threads: threads ?? [{
			id: 't-1', seq: 7, state: 'resolved', tags: ['question'], extraThread: 'keep', anchorText: 'saved',
			comments: [{
				id: 'c-1', body: 'Explain this design.', tags: ['question'], extraComment: true,
				author: { kind: 'human', name: 'reviewer', extraAuthor: 'keep' },
			}],
		}],
	};
}

async function connect(root) {
	const client = new Client({ name: 'synthetic-lighthouse-test', version: '1.0.0' });
	const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: root, stderr: 'pipe' });
	await client.connect(transport);
	return {
		client,
		async call(name, args = {}) {
			const result = await client.callTool({ name, arguments: args });
			return { ...result, data: result.structuredContent ?? JSON.parse(result.content[0].text) };
		},
	};
}

async function fixture(t, data = review()) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighthouse-mcp-'));
	await repository(root);
	const id = 'feature_main/comments.json', file = path.join(root, '.vscode', 'lighthouse-reviews', ...id.split('/'));
	if (data !== null) {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
	}
	const connection = await connect(root);
	t.after(async () => { await connection.client.close(); await fs.rm(root, { recursive: true, force: true }); });
	return { root, id, file, ...connection };
}

module.exports = { fixture, repository, review, connect, server };
