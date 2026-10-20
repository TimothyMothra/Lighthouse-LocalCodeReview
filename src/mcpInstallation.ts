import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash, randomUUID } from 'crypto';
import { record } from './reviewCore';
import { atomicReviewWrite, missing, nodeReviewIO, withReviewFileLock } from './reviewPersistence';
import { LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME } from './mcpIdentity';

const OWNER = 'TimothyMothra.lighthouse';
const TOOL_NAMES = ['list_reviews', 'get_review', 'get_thread', 'reply_to_thread'];
const PAYLOAD_FILES = ['server.cjs', 'THIRD-PARTY-NOTICES.txt'];
const LEGAL_FILE = 'server.cjs.LEGAL.txt';
const fileKey = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
export interface McpEntry { type: 'stdio'; command: string; args: string[]; tools: string[] }
interface Installation { owner: string; serverName: string; entry: McpEntry; configHome: string; version: string }
export interface Registration {
	configHome: string; storage: string; source: string; version: string;
	entry: McpEntry; snapshot: string | undefined;
	migrateLegacy: boolean;
	legacySettingsSnapshot?: string;
}

function equivalent(left: unknown, right: unknown): boolean {
	const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) :
		record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
	return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

function compareVersions(left: string, right: string): number {
	const previous = right.split('.').map(Number), next = left.split('.').map(Number);
	if (![left, right].every((version) => /^\d+\.\d+\.\d+$/.test(version)) ||
		[...previous, ...next].some((part) => !Number.isSafeInteger(part) || part < 0)) {
		throw new Error('The MCP payload version is invalid. Run explicit setup/repair.');
	}
	return next.map((part, index) => part - previous[index]).find((part) => part !== 0) ?? 0;
}

async function read(file: string): Promise<string | undefined> { return nodeReviewIO.read(file); }
function parseConfig(raw: string | undefined): Record<string, unknown> & { mcpServers: Record<string, unknown> } {
	let data: unknown;
	try { data = raw === undefined ? {} : JSON.parse(raw); }
	catch { throw new Error('The CLI MCP configuration is not valid JSON. It was not changed.'); }
	if (!record(data) || (data.mcpServers !== undefined && !record(data.mcpServers))) {
		throw new Error('The CLI MCP configuration must be a JSON object with an mcpServers object. It was not changed.');
	}
	return { ...data, mcpServers: record(data.mcpServers) ? { ...data.mcpServers } : {} };
}

async function installation(storage: string): Promise<Installation | undefined> {
	const raw = await read(path.join(storage, 'installation.json'));
	if (raw === undefined) { return undefined; }
	let data: unknown;
	try { data = JSON.parse(raw); }
	catch { throw new Error('The Lighthouse MCP ownership record is invalid. It was not overwritten.'); }
	if (!record(data) || data.owner !== OWNER || typeof data.configHome !== 'string' || typeof data.version !== 'string' ||
		!record(data.entry) || data.entry.type !== 'stdio' || typeof data.entry.command !== 'string' ||
		!Array.isArray(data.entry.args) || !data.entry.args.every((arg) => typeof arg === 'string') ||
		!Array.isArray(data.entry.tools) || !data.entry.tools.every((tool) => typeof tool === 'string') ||
		(data.serverName !== undefined && data.serverName !== MCP_SERVER_NAME && data.serverName !== LEGACY_MCP_SERVER_NAME)) {
		throw new Error('The Lighthouse MCP ownership record is invalid. It was not overwritten.');
	}
	return { owner: OWNER, serverName: typeof data.serverName === 'string' ? data.serverName : LEGACY_MCP_SERVER_NAME,
		configHome: data.configHome, version: data.version, entry: {
		type: 'stdio', command: data.entry.command, args: data.entry.args, tools: data.entry.tools,
	} };
}

async function ownedEntry(configHome: string, value: unknown, serverName: string): Promise<Installation | undefined> {
	if (!record(value) || value.type !== 'stdio' || !Array.isArray(value.args) || value.args.length !== 1 ||
		typeof value.args[0] !== 'string' || !path.isAbsolute(value.args[0]) || path.basename(value.args[0]) !== 'launcher.cjs') { return undefined; }
	const directory = path.dirname(value.args[0]);
	const raw = await read(path.join(directory, 'installation.json'));
	if (raw === undefined) { return undefined; }
	let owner: unknown;
	try { owner = JSON.parse(raw); } catch { return undefined; }
	if (!record(owner) || owner.owner !== OWNER) { return undefined; }
	const previous = await installation(directory);
	return previous && previous.serverName === serverName && fileKey(previous.configHome) === fileKey(configHome) &&
		equivalent(value, previous.entry) ? previous : undefined;
}

/** Locate only a verified owned launcher, not a general filesystem/configuration scan. */
export async function ownedInstallationStorage(configHome: string, serverName: string): Promise<string | undefined> {
	const config = parseConfig(await read(path.join(configHome, 'mcp-config.json')));
	const value = config.mcpServers[serverName];
	if (!await ownedEntry(configHome, value, serverName)) { return undefined; }
	return record(value) && Array.isArray(value.args) && typeof value.args[0] === 'string' ? path.dirname(value.args[0]) : undefined;
}

export async function installedConfigHome(storage: string): Promise<string | undefined> {
	return (await installation(storage))?.configHome;
}

async function legacySettings(configHome: string): Promise<string | undefined> {
	const raw = await read(path.join(configHome, 'settings.json'));
	let settings: unknown;
	try { settings = raw === undefined ? {} : JSON.parse(raw); }
	catch { throw new Error('The CLI settings file is not valid JSON. It was not changed.'); }
	if (!record(settings)) { throw new Error('The CLI settings file is invalid. It was not changed.'); }
	if (settings.disabledMcpServers !== undefined &&
		(!Array.isArray(settings.disabledMcpServers) || settings.disabledMcpServers.some((name) => typeof name !== 'string'))) {
		throw new Error('The CLI disabledMcpServers setting is invalid. It was not changed.');
	}
	if (Array.isArray(settings.disabledMcpServers) && settings.disabledMcpServers.includes(LEGACY_MCP_SERVER_NAME)) {
		throw new Error('The owned legacy lighthouse server is disabled. Explicitly enable or remove it through Copilot CLI before migrating; no renamed entry was created.');
	}
	return raw;
}

export async function checkNode(node: string): Promise<string> {
	if (!path.isAbsolute(node)) { throw new Error('Select an absolute path to a Node.js executable.'); }
	const { stdout } = await promisify(execFile)(node, ['--version'], { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
	if (!/^v(?:2[2-9]|[3-9]\d)\./.test(stdout.trim())) { throw new Error('Lighthouse MCP requires Node.js 22 or later. Ordinary Lighthouse review does not require it.'); }
	return stdout.trim();
}

export async function prepareRegistration(configHome: string, storage: string, source: string, version: string, node: string): Promise<Registration> {
	await checkNode(node);
	const file = path.join(configHome, 'mcp-config.json');
	const snapshot = await read(file), config = parseConfig(snapshot);
	const existing = await installation(storage);
	if (!existing) {
		try {
			if ((await fs.readdir(storage)).length) { throw new Error('The selected MCP storage directory contains unowned files. It was not overwritten.'); }
		} catch (error) { if (!missing(error)) { throw error; } }
	}
	const entry: McpEntry = { type: 'stdio', command: node, args: [path.join(storage, 'launcher.cjs')], tools: [...TOOL_NAMES] };
	if (config.mcpServers[MCP_SERVER_NAME] !== undefined && !await ownedEntry(configHome, config.mcpServers[MCP_SERVER_NAME], MCP_SERVER_NAME)) {
		throw new Error(`A different or edited ${MCP_SERVER_NAME} MCP entry already exists. Manage it explicitly; no server was replaced.`);
	}
	if (existing && fileKey(existing.configHome) !== fileKey(configHome)) {
		throw new Error('This integration belongs to a different CLI configuration directory. Remove it there before choosing another directory.');
	}
	for (const name of PAYLOAD_FILES) { await fs.access(path.join(source, name)); }
	// ASSUMPTION: the short legacy name may belong to an unrelated server. Rename only a matching owned entry.
	const migrateLegacy = !!await ownedEntry(configHome, config.mcpServers[LEGACY_MCP_SERVER_NAME], LEGACY_MCP_SERVER_NAME);
	const legacySettingsSnapshot = migrateLegacy ? await legacySettings(configHome) : undefined;
	return { configHome, storage, source, version, entry, snapshot, migrateLegacy, legacySettingsSnapshot };
}

const launcher = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required.');
  const current = JSON.parse(fs.readFileSync(path.join(__dirname, 'current.json'), 'utf8'));
  if (current.owner !== '${OWNER}' || !/^payloads\\/[a-zA-Z0-9._-]+\\/server\\.cjs$/.test(current.payload))
    throw new Error('Invalid Lighthouse payload pointer. Run Configure Copilot CLI MCP to repair it.');
  const file = path.join(__dirname, ...current.payload.split('/'));
  const real = fs.realpathSync(file), root = fs.realpathSync(__dirname);
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The Lighthouse payload leaves its installation.');
  const hash = require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (hash !== current.hash) throw new Error('Lighthouse payload verification failed. Run Configure Copilot CLI MCP.');
  // Preserve the CLI's inherited cwd: it identifies the current session worktree.
  require(real);
} catch (error) {
  process.stderr.write('Lighthouse MCP: ' + error.message + '\\n');
  process.exitCode = 1;
}
`;

async function writeOwned(file: string, value: string): Promise<void> {
	await atomicReviewWrite(file, value, nodeReviewIO, async () => {});
}

async function publishPayload(registration: Registration): Promise<void> {
	const { storage, source, version } = registration;
	const contents = await fs.readFile(path.join(source, 'server.cjs'));
	const hash = createHash('sha256').update(contents).digest('hex');
	const tag = `${version.replace(/[^a-zA-Z0-9._-]/g, '_')}-${hash.slice(0, 16)}`;
	const payloads = path.join(storage, 'payloads');
	let destination = path.join(payloads, tag);
	await fs.mkdir(payloads, { recursive: true });
	let existing = false, valid = true;
	try {
		await fs.access(destination);
		existing = true;
		for (const name of PAYLOAD_FILES) {
			try {
				if (!(await fs.readFile(path.join(source, name))).equals(await fs.readFile(path.join(destination, name)))) { valid = false; }
			} catch (error) { if (!missing(error)) { throw error; } valid = false; }
		}
	} catch (error) { if (!missing(error)) { throw error; } }
	if (!existing || !valid) {
		if (existing) { destination = path.join(payloads, `${tag}-repair-${randomUUID()}`); }
		const staged = path.join(payloads, `.stage-${randomUUID()}`);
		await fs.mkdir(staged);
		try {
			for (const name of PAYLOAD_FILES) { await fs.copyFile(path.join(source, name), path.join(staged, name)); }
			try { await fs.copyFile(path.join(source, LEGAL_FILE), path.join(staged, LEGAL_FILE)); }
			catch (error) { if (!missing(error)) { throw error; } }
			await fs.rename(staged, destination);
		} finally { await fs.rm(staged, { recursive: true, force: true }); }
	}
	if (createHash('sha256').update(await fs.readFile(path.join(destination, 'server.cjs'))).digest('hex') !== hash) {
		throw new Error('The installed payload does not match the bundled server. Repair was stopped.');
	}
	await writeOwned(path.join(storage, 'launcher.cjs'), launcher);
	await writeOwned(path.join(storage, 'current.json'), JSON.stringify({ owner: OWNER, payload: `payloads/${path.basename(destination)}/server.cjs`, hash, version }, null, 2) + '\n');
	await writeOwned(path.join(storage, 'installation.json'), JSON.stringify({
		owner: OWNER, serverName: MCP_SERVER_NAME, entry: registration.entry, configHome: registration.configHome, version,
	}, null, 2) + '\n');
}

export async function applyRegistration(registration: Registration): Promise<void> {
	const configFile = path.join(registration.configHome, 'mcp-config.json');
	await withReviewFileLock(configFile, async (assertOwned) => {
		if (await read(configFile) !== registration.snapshot) { throw new Error('The CLI configuration changed during confirmation. Run setup again; no entry was replaced.'); }
		const checkSettings = async () => {
			if (registration.migrateLegacy && await legacySettings(registration.configHome) !== registration.legacySettingsSnapshot) {
				throw new Error('The CLI settings changed during confirmation. Run setup again; no disabled server was re-enabled.');
			}
		};
		await checkSettings();
		const config = parseConfig(registration.snapshot);
		await withReviewFileLock(path.join(registration.storage, 'installation.json'), async () => {
			// ASSUMPTION: another profile may upgrade or claim this shared installation during confirmation.
			const current = await installation(registration.storage);
			if (current && fileKey(current.configHome) !== fileKey(registration.configHome)) {
				throw new Error('This integration belongs to a different CLI configuration directory. Remove it there before choosing another directory.');
			}
			if (current && compareVersions(registration.version, current.version) < 0) {
				throw new Error('A newer Lighthouse MCP payload is already installed. Use the current extension for setup/repair; no payload was downgraded.');
			}
			await publishPayload(registration);
		});
		if (registration.migrateLegacy) { delete config.mcpServers[LEGACY_MCP_SERVER_NAME]; }
		config.mcpServers[MCP_SERVER_NAME] = registration.entry;
		await atomicReviewWrite(configFile, JSON.stringify(config, null, 2) + '\n', nodeReviewIO, async () => {
			assertOwned();
			await checkSettings();
			if (await read(configFile) !== registration.snapshot) { throw new Error('The CLI configuration changed while saving. It was not overwritten.'); }
		});
		if (!equivalent(parseConfig(await read(configFile)).mcpServers[MCP_SERVER_NAME], registration.entry)) {
			throw new Error('The saved Lighthouse MCP entry differs from the requested entry. Check the CLI configuration.');
		}
	});
}

export async function refreshPayload(storage: string, source: string, version: string): Promise<boolean> {
	const existing = await installation(storage);
	if (!existing) { return false; }
	if (existing.serverName !== MCP_SERVER_NAME) { return false; }
	if (existing.version === version) { return false; }
	return withReviewFileLock(path.join(storage, 'installation.json'), async () => {
		// Re-read under the lease: another VS Code profile may have published a newer payload while we waited.
		const current = await installation(storage);
		if (!current || current.serverName !== MCP_SERVER_NAME) { return false; }
		if (compareVersions(version, current.version) <= 0) { return false; }
		const config = parseConfig(await read(path.join(current.configHome, 'mcp-config.json')));
		if (!equivalent(config.mcpServers[MCP_SERVER_NAME], current.entry)) { return false; }
		await publishPayload({ ...current, storage, source, version, snapshot: undefined, migrateLegacy: false });
		return true;
	});
}

export async function removeRegistration(storage: string): Promise<void> {
	const existing = await installation(storage);
	if (!existing) { throw new Error('No owned Lighthouse MCP installation was found.'); }
	const file = path.join(existing.configHome, 'mcp-config.json');
	await withReviewFileLock(file, async (assertOwned) => {
		const raw = await read(file), config = parseConfig(raw);
		if (config.mcpServers[existing.serverName] !== undefined && !equivalent(config.mcpServers[existing.serverName], existing.entry)) {
			throw new Error(`The ${existing.serverName} MCP entry has been edited or replaced. It was not removed.`);
		}
		delete config.mcpServers[existing.serverName];
		if (raw !== undefined) {
			await atomicReviewWrite(file, JSON.stringify(config, null, 2) + '\n', nodeReviewIO, async () => {
				assertOwned();
				if (await read(file) !== raw) { throw new Error('The CLI configuration changed while removing the entry. Try again.'); }
			});
		}
		// Only this recorded installation subtree is owned; never remove a shared global-storage root.
		await withReviewFileLock(path.join(storage, 'installation.json'), async () => {
			for (const name of ['launcher.cjs', 'current.json', 'installation.json']) { await nodeReviewIO.remove(path.join(storage, name)); }
			await fs.rm(path.join(storage, 'payloads'), { recursive: true, force: true });
		});
	});
}
