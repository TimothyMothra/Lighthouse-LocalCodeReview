import * as path from 'path';
import { promises as fs } from 'fs';
import { createHash, randomUUID } from 'crypto';
import type { GitFileEntry } from './git';
import { isReviewFilePath } from './reviewModel';
import { errorFields, event, trace } from './diagnostics';

const MAX_COMMITS = 4;
const MAX_BYTES = 4 * 1024 * 1024;
const isOid = (value: unknown): value is string =>
	typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const missing = (error: unknown): boolean =>
	typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

function parseEntry(value: unknown): GitFileEntry | undefined {
	if (value === null) { return undefined; }
	if (!object(value) || !isOid(value.oid) ||
		!(value.type === 'blob' && ['100644', '100755', '120000'].includes(String(value.mode)) ||
			value.type === 'commit' && value.mode === '160000') || typeof value.mode !== 'string') {
		throw new Error('Invalid cached Git entry.');
	}
	return { oid: value.oid, mode: value.mode, type: value.type };
}

/** Disposable lookup data only; cache failures must never certify or discard a review. */
export class GitMetadataCache {
	private readonly trees = new Map<string, Map<string, GitFileEntry | undefined>>();
	private readonly repository: string;
	private loaded?: Promise<void>;
	private timer?: NodeJS.Timeout;
	private writing?: Promise<void>;
	private dirty = false;
	private disposed = false;
	private readonly warned = new Set<string>();

	constructor(
		private readonly root: string,
		readonly file: string,
		private readonly query: (root: string, commit: string, files: string[]) => Promise<Map<string, GitFileEntry>>,
		private readonly log: (message: string) => void,
	) {
		const resolved = path.resolve(root);
		this.repository = createHash('sha256')
			.update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex');
	}

	private report(stage: string, error: unknown): void {
		const fields = errorFields(error);
		event('reviewed.metadataCacheError', { stage, ...fields });
		if (!this.warned.has(stage)) {
			this.warned.add(stage);
			this.log(`Metadata cache ${stage} failed (${fields.code ?? fields.errorType}); continuing with live Git or memory results.`);
		}
	}

	private tree(commit: string): Map<string, GitFileEntry | undefined> {
		const result = this.trees.get(commit) ?? new Map<string, GitFileEntry | undefined>();
		this.trees.delete(commit); this.trees.set(commit, result);
		if (this.trees.size > MAX_COMMITS) {
			this.trees.delete(this.trees.keys().next().value!);
			event('reviewed.metadataCacheEvicted', { reason: 'commitLimit' });
		}
		return result;
	}

	private async readText(): Promise<string> {
		const handle = await fs.open(this.file, 'r');
		try {
			const bytes = Buffer.allocUnsafe(MAX_BYTES + 1);
			let size = 0;
			while (size < bytes.length) {
				const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
				if (!bytesRead) { break; }
				size += bytesRead;
			}
			if (size > MAX_BYTES) { throw new Error('Metadata cache exceeds its size limit.'); }
			return bytes.subarray(0, size).toString('utf8');
		} finally { await handle.close(); }
	}

	private load(): Promise<void> {
		this.loaded ??= trace('reviewed.metadataCacheLoad', async () => {
			let text: string;
			try { text = await this.readText(); } catch (error) {
				if (missing(error)) { event('reviewed.metadataCacheLoaded', { outcome: 'missing' }); return; }
				throw error;
			}
			const raw: unknown = JSON.parse(text);
			if (!object(raw) || raw.version !== 1 || typeof raw.repository !== 'string' ||
				!Array.isArray(raw.commits) || raw.commits.length > MAX_COMMITS) {
				throw new Error('Invalid metadata cache format.');
			}
			if (raw.repository !== this.repository) {
				event('reviewed.metadataCacheLoaded', { outcome: 'repositoryChanged' }); return;
			}
			const parsed = new Map<string, Map<string, GitFileEntry | undefined>>();
			for (const row of raw.commits) {
				if (!object(row) || !isOid(row.commit) || !Array.isArray(row.files) || parsed.has(row.commit)) {
					throw new Error('Invalid cached commit.');
				}
				const files = new Map<string, GitFileEntry | undefined>();
				for (const item of row.files) {
					if (!object(item) || typeof item.path !== 'string' || !isReviewFilePath(item.path) || files.has(item.path)) {
						throw new Error('Invalid cached file path.');
					}
					files.set(item.path, parseEntry(item.entry));
				}
				parsed.set(row.commit, files);
			}
			// ASSUMPTION: publish only a fully validated document, never a partially parsed cache.
			for (const [commit, files] of parsed) {
				const tree = this.tree(commit);
				for (const [file, entry] of files) { tree.set(file, entry); }
			}
			event('reviewed.metadataCacheLoaded', { outcome: 'hit', commitCount: this.trees.size, byteCount: Buffer.byteLength(text) });
		}).catch((error: unknown) => this.report('load', error));
		return this.loaded;
	}

	async entries(commit: string, files: string[]): Promise<Map<string, GitFileEntry | undefined>> {
		if (!isOid(commit) || files.some((file) => !isReviewFilePath(file))) {
			throw new Error('Metadata lookup requires a full commit SHA and repository-relative paths.');
		}
		if (!files.length) { return new Map(); }
		await this.load();
		const tree = this.tree(commit);
		const needed = files.filter((file) => !tree.has(file));
		const result = new Map(files.filter((file) => tree.has(file)).map((file) => [file, tree.get(file)]));
		event('reviewed.treeCache', { outcome: needed.length ? 'miss' : 'hit', fileCount: files.length, missingCount: needed.length });
		if (needed.length) {
			// Concurrent misses may repeat a query. Snapshot hits before awaiting so eviction cannot
			// turn a valid cached entry into an apparent absence during another request.
			const fetched = await this.query(this.root, commit, needed);
			const current = this.tree(commit);
			for (const file of needed) {
				const entry = fetched.get(file);
				current.set(file, entry && { ...entry }); result.set(file, entry);
			}
			this.dirty = true;
			if (!this.timer && !this.disposed) {
				this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 50);
			}
		}
		return result;
	}

	private serialize(): string {
		for (;;) {
			const text = JSON.stringify({
				version: 1, repository: this.repository,
				commits: [...this.trees].map(([commit, files]) => ({
					commit, files: [...files].map(([file, entry]) => ({ path: file, entry: entry ?? null })),
				})),
			}) + '\n';
			if (Buffer.byteLength(text) <= MAX_BYTES) { return text; }
			const oldest = this.trees.keys().next().value!;
			if (this.trees.size > 1) { this.trees.delete(oldest); } else {
				const tree = this.trees.get(oldest)!;
				if (!tree.size) { throw new Error('Metadata cache header exceeds its size limit.'); }
				let remove = Math.max(1, Math.ceil(tree.size / 4));
				for (const file of tree.keys()) { tree.delete(file); if (--remove === 0) { break; } }
			}
			event('reviewed.metadataCacheEvicted', { reason: 'byteLimit' });
		}
	}

	private async write(text: string): Promise<void> {
		const temporary = path.join(path.dirname(this.file), `metadata-cache.${randomUUID()}.tmp`);
		const commitCount = this.trees.size;
		try {
			await fs.mkdir(path.dirname(this.file), { recursive: true });
			await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
			// Never replace comments.json or delete a good cache to work around a failed rename.
			await fs.rename(temporary, this.file);
			event('reviewed.metadataCacheWritten', { byteCount: Buffer.byteLength(text), commitCount });
		} finally {
			try { await fs.unlink(temporary); } catch (error) {
				if (!missing(error)) { this.report('cleanup', error); }
			}
		}
	}

	async flush(): Promise<void> {
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
		if (this.writing) { return this.writing; }
		if (!this.dirty) { return; }
		const pending = (async () => {
			while (this.dirty) {
				this.dirty = false;
				try {
					const text = this.serialize();
					await trace('reviewed.metadataCacheWrite', () => this.write(text));
				} catch (error) { this.report('write', error); }
			}
		})();
		this.writing = pending;
		try { await pending; } finally { if (this.writing === pending) { this.writing = undefined; } }
	}

	dispose(): void {
		this.disposed = true;
		void this.flush();
	}
}
