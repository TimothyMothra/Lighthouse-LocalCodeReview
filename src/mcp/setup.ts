import * as path from 'node:path';
import * as os from 'node:os';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { applyRegistration, prepareRegistration } from '../mcpInstallation';
import { MCP_SERVER_NAME, mcpStorageDirectory } from '../mcpIdentity';
import { record } from '../reviewCore';
import { ReviewAccess, ReviewError } from './access';

declare const LIGHTHOUSE_VERSION: string;

async function main(): Promise<void> {
	const { values } = parseArgs({ options: {
		home: { type: 'string' }, storage: { type: 'string' }, source: { type: 'string' },
		node: { type: 'string' }, workspace: { type: 'string' },
		check: { type: 'boolean' }, yes: { type: 'boolean' }, help: { type: 'boolean' },
	} });
	if (values.help) {
		process.stdout.write('Lighthouse MCP setup: node setup.cjs --check | --yes [--home DIR] [--storage DIR] [--source DIR] [--node EXE] [--workspace DIR]\n');
		return;
	}
	if (!!values.check === !!values.yes) { throw new Error('Choose --check for a read-only preflight or --yes to explicitly register the server.'); }
	const configHome = path.resolve(values.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot'));
	const storage = path.resolve(values.storage ?? mcpStorageDirectory());
	const source = path.resolve(values.source ?? __dirname);
	const node = values.node ?? process.execPath;
	const workspace = path.resolve(values.workspace ?? process.cwd());
	const registration = await prepareRegistration(configHome, storage, source, LIGHTHOUSE_VERSION, node);
	const summary = {
		serverName: MCP_SERVER_NAME, configFile: path.join(configHome, 'mcp-config.json'),
		storage, version: LIGHTHOUSE_VERSION, migrateLegacy: registration.migrateLegacy,
	};
	if (values.check) {
		process.stdout.write(JSON.stringify({ ...summary, preflight: 'passed', changed: false }) + '\n');
		return;
	}
	await applyRegistration(registration);
	// Registration is durable before the live probe. Report a failed probe as a partial outcome, not rollback.
	const client = new Client({ name: 'lighthouse-codereview-setup', version: LIGHTHOUSE_VERSION });
	try {
		let expectedRoot: string | undefined;
		try { expectedRoot = await new ReviewAccess(workspace).root(); }
		catch (error) { if (!(error instanceof ReviewError) || error.code !== 'NO_WORKTREE') { throw error; } }
		await client.connect(new StdioClientTransport({ command: registration.entry.command, args: registration.entry.args, cwd: workspace, stderr: 'pipe' }));
		if (client.getServerVersion()?.name !== MCP_SERVER_NAME || client.getServerVersion()?.version !== LIGHTHOUSE_VERSION) {
			throw new Error('The registered payload reports the wrong MCP identity or version.');
		}
		const tools = await client.listTools();
		const actual = tools.tools.map((tool) => tool.name).sort();
		if (JSON.stringify(actual) !== JSON.stringify([...registration.entry.tools].sort())) { throw new Error('The registered payload exposes unexpected tools.'); }
		const result = await client.callTool({ name: 'list_reviews', arguments: {} }, CallToolResultSchema);
		const content: unknown[] = Array.isArray(result.content) ? result.content : [];
		const text = content.find((item) => record(item) && item.type === 'text' && typeof item.text === 'string');
		const data: unknown = result.structuredContent ?? (record(text) && typeof text.text === 'string' ? JSON.parse(text.text) : undefined);
		if (!record(data)) { throw new Error('The review read check returned an invalid result.'); }
		if (result.isError) {
			if (expectedRoot || !record(data.error) || data.error.code !== 'NO_WORKTREE') { throw new Error('The registered server could not read review metadata in the expected worktree. Inspect it with /mcp in a new CLI session.'); }
			process.stdout.write(JSON.stringify({
				...summary, registered: true, toolsVerified: actual, contextVerified: false,
				note: 'Protocol verified; worktree check skipped because this directory is not a Git worktree. Start the CLI in the reviewed worktree.',
			}) + '\n');
		} else {
			const sameRoot = typeof data.workspaceRoot === 'string' && expectedRoot &&
				(process.platform === 'win32' ? data.workspaceRoot.toLowerCase() === expectedRoot.toLowerCase() : data.workspaceRoot === expectedRoot);
			if (!sameRoot) { throw new Error('The registered server is bound to a different worktree than requested.'); }
			process.stdout.write(JSON.stringify({
				...summary, registered: true, toolsVerified: actual, contextVerified: true,
				workspaceRoot: data.workspaceRoot, reviewReadComplete: data.complete, reviewIssues: data.issues,
			}) + '\n');
		}
	} catch (error) {
		throw new Error(`Registration was saved, but standalone MCP verification failed: ${error instanceof Error ? error.message : String(error)}. Do not assume a running CLI connection was refreshed.`);
	} finally { await client.close(); }
}

main().catch((error) => {
	process.stderr.write(`Lighthouse MCP setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
