import * as os from 'os';
import * as path from 'path';

export const MCP_SERVER_NAME = 'lighthouse-codereview';
export const LEGACY_MCP_SERVER_NAME = 'lighthouse';

/** Shared by GUI and headless setup; no dependency on a VS Code profile or extension version. */
export function mcpStorageDirectory(): string {
	const data = process.platform === 'win32'
		? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
		: process.platform === 'darwin'
			? path.join(os.homedir(), 'Library', 'Application Support')
			: process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
	return path.join(data, 'Lighthouse', 'copilot-mcp');
}
