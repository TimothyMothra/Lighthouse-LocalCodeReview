import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { applyRegistration, installedConfigHome, ownedInstallationStorage, prepareRegistration, refreshPayload, removeRegistration } from './mcpInstallation';
import { LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME, mcpStorageDirectory } from './mcpIdentity';

const ENABLED = 'mcp.userInstallation';
function locations(context: vscode.ExtensionContext) {
	// ASSUMPTION: CLI/Node run on this extension host; VS Code storage providers may use non-file URIs.
	if (vscode.env.remoteName && context.extension.extensionKind !== vscode.ExtensionKind.Workspace) {
		throw new Error('This command is running in the UI extension host while the workspace is remote. Run Lighthouse in the workspace extension host, or run scripts\\setup-mcp.ps1 on the CLI host. No CLI configuration was changed.');
	}
	if (!path.isAbsolute(context.extensionPath)) {
		throw new Error('MCP setup requires a disk-backed extension path in the Node extension host. Run scripts\\setup-mcp.ps1 on the CLI host instead.');
	}
	return { storage: mcpStorageDirectory(), source: path.join(context.extensionPath, 'out', 'mcp') };
}

async function defaultNode(): Promise<string | undefined> {
	for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!directory) { continue; }
		const file = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
		try { if ((await fs.stat(file)).isFile()) { return path.resolve(file); } }
		catch (error) {
			if (typeof error !== 'object' || error === null || !('code' in error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) { throw error; }
		}
	}
	return undefined;
}

export async function configureCopilotMcp(context: vscode.ExtensionContext): Promise<void> {
	try {
		if (vscode.workspace.isTrusted === false) { throw new Error('Trust this workspace before configuring executable MCP integration.'); }
		const paths = locations(context);
		const action = await vscode.window.showQuickPick([
			{ label: 'Set up or repair', value: 'setup', description: 'One user-level entry for all new CLI repositories and worktrees' },
			{ label: 'Remove integration', value: 'remove', description: 'Remove only the recorded Lighthouse entry and its owned server payloads' },
		], { title: 'Lighthouse: Copilot CLI MCP' });
		if (!action) { return; }
		const storedHome = await installedConfigHome(paths.storage) ?? context.globalState.get<string>(ENABLED);
		const defaultHome = storedHome ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
		if (action.value === 'remove') {
			const confirmed = await vscode.window.showWarningMessage('Remove Lighthouse MCP from the recorded CLI profile? Other servers and review JSON will not be changed.',
				{ modal: true }, 'Remove Lighthouse MCP');
			if (confirmed !== 'Remove Lighthouse MCP') { return; }
			const storage = await ownedInstallationStorage(defaultHome, MCP_SERVER_NAME) ??
				await ownedInstallationStorage(defaultHome, LEGACY_MCP_SERVER_NAME) ?? paths.storage;
			await removeRegistration(storage);
			await context.globalState.update(ENABLED, undefined);
			void vscode.window.showInformationMessage('Lighthouse MCP removed. Restart an existing CLI connection to unload its running server.');
			return;
		}
		const configHome = await vscode.window.showInputBox({
			title: 'Copilot CLI configuration directory',
			prompt: `Use the Copilot home on this ${process.platform} extension host${vscode.env.remoteName ? ` (workspace: ${vscode.env.remoteName})` : ''}. Your CLI must run on this host; this is not a repository folder.`,
			value: defaultHome,
			validateInput: (value) => path.isAbsolute(value) ? undefined : 'Enter an absolute configuration directory.',
		});
		if (!configHome) { return; }
		let node = await defaultNode();
		const nodeChoice = await vscode.window.showQuickPick([
			...(node ? [{ label: 'Use Node.js from PATH', value: 'path', description: node }] : []),
			{ label: 'Select a Node.js executable', value: 'select', description: 'Node.js 22 or later; no automatic runtime installation' },
		], { title: 'Lighthouse MCP runtime' });
		if (!nodeChoice) { return; }
		if (nodeChoice.value === 'select') {
			const files = await vscode.window.showOpenDialog({ title: 'Select Node.js', canSelectMany: false, canSelectFolders: false });
			node = files?.[0]?.fsPath;
		}
		if (!node) { return; }
		const registration = await prepareRegistration(path.resolve(configHome), paths.storage, paths.source, context.extension.packageJSON.version, node);
		const confirmed = await vscode.window.showInformationMessage(
			`Register user-level ${MCP_SERVER_NAME} MCP?\nExtension host: ${process.platform}${vscode.env.remoteName ? `, remote workspace (${vscode.env.remoteName})` : ', local'}\nConfiguration: ${path.join(registration.configHome, 'mcp-config.json')}\nNode: ${node}\nLauncher: ${registration.entry.args[0]}\nTools: ${registration.entry.tools.join(', ')}\nMigrate owned legacy entry: ${registration.migrateLegacy ? 'yes' : 'no'}\nNo repository is pinned; your CLI must run on this extension host.`,
			{ modal: true }, 'Register Lighthouse MCP');
		if (confirmed !== 'Register Lighthouse MCP') { return; }
		await applyRegistration(registration);
		await context.globalState.update(ENABLED, registration.configHome);
		void vscode.window.showInformationMessage('Lighthouse MCP configured for new CLI sessions in any local worktree. Refresh/restart an existing CLI MCP connection, then ask it to list Lighthouse reviews.');
	} catch (error) {
		void vscode.window.showErrorMessage(`Lighthouse MCP setup failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function refreshCopilotMcp(context: vscode.ExtensionContext): Promise<void> {
	try {
		const paths = locations(context);
		await refreshPayload(paths.storage, paths.source, context.extension.packageJSON.version);
	} catch {
		void vscode.window.showWarningMessage('Lighthouse could not refresh its previously enabled MCP payload. Run Configure Copilot CLI MCP to inspect/repair it; no CLI server was re-enabled.');
	}
}
