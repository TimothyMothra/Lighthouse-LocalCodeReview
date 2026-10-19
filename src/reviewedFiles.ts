import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import { constants, promises as fs, BigIntStats } from 'fs';
import { ActiveComparison } from './activeComparison';
import { GitFileEntry, hashGitBlob, readGitFileEntries, runGitQuery } from './git';
import {
	clearLegacyReviewedFiles, isReviewFilePath, ReviewedFileSide, ReviewedFileSnapshot,
	sameReviewedSnapshot, setFileReviewed,
} from './reviewModel';
import { updateReview } from './reviewStore';
import { diagnosticsEnabled, errorFields, event, Fields, now, trace } from './diagnostics';
import { GitMetadataCache } from './gitMetadataCache';

interface SnapshotContext {
	root: string; file: string; baseline: string; source: string; working: boolean; key: string;
}

function missing(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function fileKey(file: string): string {
	const absolute = path.resolve(file);
	return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function statStamp(stat: BigIntStats): string {
	return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':');
}

export function reviewFileAbsolute(root: string, file: string): string {
	const absolute = path.resolve(root, file);
	const relative = path.relative(root, absolute);
	if (!isReviewFilePath(file) || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('The reviewed file must be inside the repository.');
	}
	return absolute;
}

function gitSide(entry?: GitFileEntry): ReviewedFileSide {
	if (!entry) { return { kind: 'absent' }; }
	if (entry.type !== 'blob' || !['100644', '100755', '120000'].includes(entry.mode)) {
		throw new Error('Reviewed-state tracking does not support this Git file type or submodule.');
	}
	return { kind: entry.mode === '120000' ? 'symlink' : 'file', hash: entry.oid, mode: entry.mode };
}

export class FileSnapshotReader {
	private readonly metadata = new Map<string, GitMetadataCache>();
	private readonly retiredWrites = new Set<Promise<void>>();
	private readonly blobs = new Map<string, Promise<string>>();
	private readonly saved = new Map<string, { side: ReviewedFileSide; sourceKey: string; stamp: string }>();
	private readonly stamps = new Map<string, string>();
	private readonly fileModes = new Map<string, Promise<boolean>>();

	constructor(private readonly log: (message: string) => void = (message) => console.warn(`[lighthouse] ${message}`)) {}

	reset(): void { this.saved.clear(); this.stamps.clear(); }
	async flushMetadata(): Promise<void> {
		await Promise.all([...this.metadata.values()].map((cache) => cache.flush()).concat([...this.retiredWrites]));
	}
	dispose(): void { for (const cache of this.metadata.values()) { this.retire(cache); } }

	private retire(cache: GitMetadataCache): void {
		cache.dispose();
		const pending = cache.flush();
		this.retiredWrites.add(pending);
		void pending.then(() => this.retiredWrites.delete(pending));
	}
	refreshConfiguration(): void { this.fileModes.clear(); }
	forget(root: string, file: string): void {
		const absolute = reviewFileAbsolute(root, file);
		this.saved.delete(absolute); this.stamps.delete(absolute);
	}

	private async stamp(absolute: string): Promise<string> {
		try { return statStamp(await fs.lstat(absolute, { bigint: true })); } catch (error) {
			if (missing(error)) { return 'absent'; }
			throw error;
		}
	}

	async savedMayHaveChanged(root: string, file: string): Promise<boolean> {
		const absolute = reviewFileAbsolute(root, file);
		return this.saved.get(absolute)?.stamp !== await this.stamp(absolute);
	}

	private entries(context: SnapshotContext, commit: string, files: string[]): Promise<Map<string, GitFileEntry | undefined>> {
		if (!files.length) { return Promise.resolve(new Map()); }
		const cacheFile = path.join(path.dirname(context.file), 'metadata-cache.json');
		const key = JSON.stringify([fileKey(context.root), fileKey(cacheFile)]);
		let cache = this.metadata.get(key);
		if (!cache) {
			if (this.metadata.size >= 4) {
				const oldest = this.metadata.keys().next().value!;
				this.retire(this.metadata.get(oldest)!); this.metadata.delete(oldest);
			}
			cache = new GitMetadataCache(context.root, cacheFile, readGitFileEntries, this.log);
		}
		this.metadata.delete(key); this.metadata.set(key, cache);
		return cache.entries(commit, files);
	}

	private fileMode(root: string): Promise<boolean> {
		let cached = this.fileModes.get(root);
		if (!cached) {
			cached = runGitQuery(root, ['config', '--get', 'core.fileMode']).then((value) => value === 'true', (error: unknown) => {
				if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
					return process.platform !== 'win32';
				}
				throw error;
			});
			this.fileModes.set(root, cached);
			void cached.catch(() => this.fileModes.delete(root));
		}
		return cached;
	}

	private async savedSide(root: string, file: string, entry?: GitFileEntry): Promise<ReviewedFileSide> {
		const absolute = reviewFileAbsolute(root, file);
		return trace('reviewed.savedHash', async () => {
			let before: BigIntStats;
			try { before = await fs.lstat(absolute, { bigint: true }); } catch (error) {
				if (missing(error)) {
					this.stamps.set(absolute, 'absent');
					event('reviewed.savedRead', { kind: 'absent', byteCount: 0 });
					return { kind: 'absent' };
				}
				throw error;
			}
			const [realRoot, realParent] = await Promise.all([fs.realpath(root), fs.realpath(path.dirname(absolute))]);
			const relative = path.relative(realRoot, realParent);
			if (relative.startsWith('..') || path.isAbsolute(relative)) {
				throw new Error('The reviewed path traverses a directory link outside the repository.');
			}
			const physical = path.join(realParent, path.basename(absolute));
			const hash = createHash('sha256');
			let kind: 'file' | 'symlink', mode: string;
			if (before.isSymbolicLink()) {
				kind = 'symlink'; mode = '120000';
				hash.update(await fs.readlink(physical, { encoding: 'buffer' }));
			} else if (before.isFile()) {
				kind = 'file';
				const trackMode = await this.fileMode(root);
				mode = trackMode ? (before.mode & 0o111n ? '100755' : '100644') :
					entry?.mode === '100755' ? '100755' : '100644';
				const handle = await fs.open(physical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				try {
					const opened = await handle.stat({ bigint: true });
					if (opened.ino !== before.ino || opened.dev !== before.dev) {
						throw new Error('The saved file changed before it could be fingerprinted.');
					}
					const buffer = Buffer.allocUnsafe(64 * 1024);
					for (;;) {
						const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
						if (!bytesRead) { break; }
						hash.update(buffer.subarray(0, bytesRead));
					}
				} finally { await handle.close(); }
			} else { throw new Error('Reviewed-state tracking requires a regular file or symbolic link.'); }
			const after = await fs.lstat(absolute, { bigint: true });
			if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
				before.ctimeNs !== after.ctimeNs || before.mode !== after.mode) {
				throw new Error('The saved file changed while it was being fingerprinted. Retry after the save finishes.');
			}
			this.stamps.set(absolute, statStamp(after));
			event('reviewed.savedRead', { kind, byteCount: Number(after.size) });
			return { kind, hash: hash.digest('hex'), mode };
		});
	}

	async prepare(context: SnapshotContext, files: string[]): Promise<void> {
		const left = this.entries(context, context.baseline, files);
		await Promise.all([left, context.source === context.baseline ? left : this.entries(context, context.source, files)]);
	}

	async read(context: SnapshotContext, file: string, forceSaved = true): Promise<ReviewedFileSnapshot> {
		const leftQuery = this.entries(context, context.baseline, [file]);
		const [leftEntries, rightEntries] = await Promise.all([
			leftQuery, context.source === context.baseline ? leftQuery : this.entries(context, context.source, [file]),
		]);
		const left = gitSide(leftEntries.get(file)), sourceEntry = rightEntries.get(file);
		let right: ReviewedFileSide;
		if (context.working) {
			if (sourceEntry && sourceEntry.type !== 'blob') { gitSide(sourceEntry); }
			const absolute = reviewFileAbsolute(context.root, file), cached = this.saved.get(absolute);
			const sourceKey = JSON.stringify(sourceEntry) ?? 'absent';
			const currentStamp = !forceSaved && cached && cached.sourceKey === sourceKey ? await this.stamp(absolute) : undefined;
			const hit = !!cached && !forceSaved && cached.sourceKey === sourceKey && cached.stamp === currentStamp;
			event('reviewed.savedCache', {
				outcome: hit ? 'hit' : 'miss',
				reason: hit ? 'unchanged' : forceSaved ? 'forced' : !cached ? 'uncached' :
					cached.sourceKey !== sourceKey ? 'sourceChanged' : 'metadataChanged',
			});
			if (hit && cached) {
				right = cached.side;
			} else {
				right = await this.savedSide(context.root, file, sourceEntry);
				this.saved.set(absolute, { side: right, sourceKey, stamp: this.stamps.get(absolute)! });
			}
		} else {
			right = gitSide(sourceEntry);
			if (right.kind !== 'absent') {
				const key = JSON.stringify([context.root, right.hash]);
				let fingerprint = this.blobs.get(key);
				event('reviewed.blobCache', { outcome: fingerprint ? 'hit' : 'miss' });
				if (!fingerprint) {
					if (this.blobs.size >= 512) { this.blobs.delete(this.blobs.keys().next().value!); }
					fingerprint = hashGitBlob(context.root, right.hash);
					this.blobs.set(key, fingerprint);
					void fingerprint.catch(() => this.blobs.delete(key));
				}
				right = { ...right, hash: await fingerprint };
			}
		}
		return { version: 1, left, right };
	}
}

export interface ReviewAvailability {
	reviewed: boolean; dirty: boolean; pending: boolean; error?: string;
}

interface FileState { pending: boolean; signature?: string; error?: string }
interface QueuedValidation {
	forceSaved: boolean;
	firstQueuedAt: number;
	readyAt: number;
}
class OvertakenReview extends Error {}

export class ReviewedFiles implements vscode.Disposable {
	private readonly reader: FileSnapshotReader;
	private readonly states = new Map<string, FileState>();
	private readonly versions = new Map<string, number>();
	private readonly queued = new Map<string, QueuedValidation>();
	private readonly watches = new Map<string, vscode.FileSystemWatcher>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly dirty = new Set<string>();
	private readonly checking = new Map<string, { key: string; token: symbol }>();
	private readonly watchedPaths = new Map<string, string>();
	private readonly fileIds = new Map<string, number>();
	private readonly outputMappings = new Set<number>();
	private comparisonGeneration = 0;
	private nextFileId = 0;
	private nextPassId = 0;
	private adoptedKey = '';
	private timer?: NodeJS.Timeout;
	private timerAt?: number;
	private running = false;
	private disposed = false;

	constructor(
		private readonly getActive: () => ActiveComparison | undefined,
		private readonly changed: () => void,
		private readonly log: (message: string) => void,
	) {
		this.reader = new FileSnapshotReader(log);
		for (const document of vscode.workspace.textDocuments ?? []) {
			if (document.uri.scheme === 'file' && document.isDirty) { this.dirty.add(fileKey(document.uri.fsPath)); }
		}
		const change = vscode.workspace.onDidChangeTextDocument?.((e) => this.dirtyDocument(e.document));
		const close = vscode.workspace.onDidCloseTextDocument?.((document) => {
			if (this.dirty.delete(fileKey(document.uri.fsPath))) {
				this.logDirty(document.uri, false, 'close'); this.changed();
			}
		});
		const save = vscode.workspace.onDidSaveTextDocument?.((document) => {
			this.dirtyDocument(document); this.savedChanged(document.uri, 'save');
		});
		for (const subscription of [change, close, save]) { if (subscription) { this.subscriptions.push(subscription); } }
	}

	private context(): SnapshotContext | undefined {
		const active = this.getActive();
		if (!active?.sourceFile || !active.baselineCommit || !active.compareCommit || active.baselineError) { return undefined; }
		const values = [active.repoRootFsPath, active.sourceFile, active.baselineCommit, active.compareCommit, active.compareIsHead];
		return {
			root: active.repoRootFsPath, file: active.sourceFile, baseline: active.baselineCommit,
			source: active.compareCommit, working: active.compareIsHead, key: JSON.stringify(values),
		};
	}

	get key(): string { return this.context()?.key ?? ''; }

	private fileFields(file: string): { comparisonGeneration: number; fileId: number } {
		let fileId = this.fileIds.get(file);
		if (fileId === undefined) {
			fileId = ++this.nextFileId; this.fileIds.set(file, fileId);
		}
		// ASSUMPTION: paths stay in local Output only, never in exportable trace fields.
		if (diagnosticsEnabled() && !this.outputMappings.has(fileId)) {
			this.outputMappings.add(fileId);
			this.log(`[reviewed] comparison=${this.comparisonGeneration} fileId=${fileId} path=${JSON.stringify(file)}`);
		}
		return { comparisonGeneration: this.comparisonGeneration, fileId };
	}

	private trigger(reason: string): string {
		return [
			'startup', 'select-base', 'select-compare', 'manual-refresh', 'manual-resolve-refresh',
			'review-created', 'review-changed', 'review-deleted', 'git-api-state', 'git-operation',
			'ref-changed', 'ref-created', 'ref-deleted', 'retry-in-flight', 'unpin-base',
			'command-or-review-action', 'conversation-page',
		].includes(reason) ? reason : 'other';
	}

	private logDirty(uri: vscode.Uri, dirty: boolean, trigger: string): void {
		const context = this.context();
		if (!context?.working || uri.scheme !== 'file') { return; }
		const file = path.relative(context.root, uri.fsPath).replace(/\\/g, '/');
		if (isReviewFilePath(file)) { event('reviewed.dirty', { ...this.fileFields(file), dirty, trigger }); }
	}

	availability(file: string): ReviewAvailability {
		const context = this.context(), state = context?.key === this.adoptedKey ? this.states.get(file) : undefined;
		return {
			reviewed: !!this.getActive()?.review?.reviewedFiles?.includes(file),
			dirty: !!context?.working && this.dirty.has(fileKey(reviewFileAbsolute(context.root, file))),
			pending: !!state?.pending || (!!this.getActive()?.review?.reviewedFiles?.includes(file) && !state?.signature),
			error: state?.error,
		};
	}

	private dirtyDocument(document: vscode.TextDocument): void {
		if (document.uri.scheme !== 'file') { return; }
		const key = fileKey(document.uri.fsPath), wasDirty = this.dirty.has(key);
		if (document.isDirty) { this.dirty.add(key); } else { this.dirty.delete(key); }
		if (wasDirty !== !!document.isDirty) {
			this.logDirty(document.uri, !!document.isDirty, 'editor'); this.changed();
		}
	}

	reconcile(reason: string): void {
		if (this.disposed) { return; }
		const context = this.context();
		if (!context) {
			event('reviewed.reconcile', { trigger: this.trigger(reason), outcome: 'unresolved' });
			this.clear(); return;
		}
		if (reason.startsWith('manual-')) { this.reader.refreshConfiguration(); }
		const moved = context.key !== this.adoptedKey;
		if (moved) {
			const previous = this.adoptedKey ? JSON.parse(this.adoptedKey) as unknown[] : [];
			if (previous[0] !== context.root || previous[1] !== context.file || previous[4] !== context.working) { this.reader.reset(); }
			this.adoptedKey = context.key; this.states.clear(); this.queued.clear();
			this.comparisonGeneration++; this.fileIds.clear(); this.outputMappings.clear();
		}
		const checked = this.getActive()?.review?.reviewedFiles ?? [];
		const reconcileAt = now() + 250;
		event('reviewed.reconcile', {
			comparisonGeneration: this.comparisonGeneration, trigger: this.trigger(reason),
			moved, working: context.working, checkedCount: checked.length,
		});
		for (const file of [...this.states.keys()]) {
			if (!checked.includes(file) && !this.checking.has(file)) {
				this.states.delete(file); this.reader.forget(context.root, file);
			}
		}
		for (const file of checked) {
			if (!isReviewFilePath(file)) { this.enqueue(file, false, 'legacy', reconcileAt); continue; }
			const snapshot = this.getActive()?.review?.reviewedFileSnapshots?.[file];
			const signature = snapshot && JSON.stringify(snapshot);
			if (moved || reason.startsWith('manual-') || this.states.get(file)?.signature !== signature || !signature) {
				this.enqueue(file, !moved || reason === 'startup', this.trigger(reason), reconcileAt);
			}
		}
		this.syncWatches(context);
		if (!moved && context.working && ['git-api-state', 'retry-in-flight', 'ref-changed', 'ref-created', 'ref-deleted'].includes(reason)) {
			void this.savedHints(context, checked);
		}
		this.changed();
	}

	private async savedHints(context: SnapshotContext, files: string[]): Promise<void> {
		for (const file of files) {
			if (!isReviewFilePath(file) || this.states.get(file)?.pending) { continue; }
			try {
				const changed = await this.reader.savedMayHaveChanged(context.root, file);
				if (this.key !== context.key || this.disposed) { return; }
				event('reviewed.savedHint', { ...this.fileFields(file), changed });
				if (changed && !this.states.get(file)?.pending) { this.enqueue(file, true, 'git-hint'); }
			} catch (error) {
				if (this.key !== context.key) { return; }
				this.states.set(file, { pending: false, error: error instanceof Error ? error.message : String(error) });
				this.failure(error, { ...this.fileFields(file), stage: 'metadataHint' }); this.changed();
			}
		}
	}

	private clear(): void {
		this.adoptedKey = ''; this.states.clear(); this.queued.clear(); this.reader.reset();
		if (this.timer) { clearTimeout(this.timer); }
		this.timer = undefined; this.timerAt = undefined;
		this.watchedPaths.clear();
		this.fileIds.clear(); this.outputMappings.clear();
		for (const watch of this.watches.values()) { watch.dispose(); } this.watches.clear();
	}

	private syncWatches(context: SnapshotContext): void {
		const previousCount = this.watches.size;
		const previousPathCount = this.watchedPaths.size;
		let changed = false;
		const directories = new Set<string>();
		this.watchedPaths.clear();
		if (context.working) {
			const checking = [...this.checking].filter(([, value]) => value.key === context.key).map(([file]) => file);
			for (const file of [...(this.getActive()?.review?.reviewedFiles ?? []), ...checking]) {
				if (isReviewFilePath(file)) {
					const absolute = reviewFileAbsolute(context.root, file);
					directories.add(path.dirname(absolute)); this.watchedPaths.set(fileKey(absolute), file);
				}
			}
		}
		for (const [directory, watcher] of this.watches) {
			if (!directories.has(directory)) { watcher.dispose(); this.watches.delete(directory); changed = true; }
		}
		for (const directory of directories) {
			if (this.watches.has(directory)) { continue; }
			try {
				// Watch only checked-file parents; filter events by exact path, not filename glob syntax.
				const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(directory), '*'));
				watcher.onDidChange((uri) => this.savedChanged(uri, 'file-change'));
				watcher.onDidCreate((uri) => this.savedChanged(uri, 'file-create'));
				watcher.onDidDelete((uri) => this.savedChanged(uri, 'file-delete'));
				this.watches.set(directory, watcher);
				changed = true;
			} catch (error) { this.failure(error, { comparisonGeneration: this.comparisonGeneration, stage: 'watch' }); }
		}
		if (changed || previousCount !== this.watches.size || previousPathCount !== this.watchedPaths.size) {
			event('reviewed.watches', { comparisonGeneration: this.comparisonGeneration, directoryCount: this.watches.size, pathCount: this.watchedPaths.size });
		}
	}

	private savedChanged(uri: vscode.Uri, trigger: string): void {
		const context = this.context();
		if (!context?.working || uri.scheme !== 'file') { return; }
		const file = this.watchedPaths.get(fileKey(uri.fsPath));
		const checking = file && this.checking.get(file)?.key === context.key;
		if (!file ||
			(!this.getActive()?.review?.reviewedFiles?.includes(file) && !checking)) { return; }
		this.versions.set(file, (this.versions.get(file) ?? 0) + 1);
		event('reviewed.sourceChanged', { ...this.fileFields(file), trigger, version: this.versions.get(file), checking: !!checking });
		if (!checking) { this.enqueue(file, true, trigger); }
	}

	private enqueue(file: string, force: boolean, trigger: string, reconcileAt?: number): void {
		const at = now(), pending = this.queued.get(file);
		const firstQueuedAt = pending?.firstQueuedAt ?? at;
		const filesystem = ['file-change', 'file-create', 'file-delete', 'git-hint'].includes(trigger);
		// ASSUMPTION: an explicit save is complete; only filesystem bursts need a quiet window.
		let readyAt = trigger === 'save' ? at : filesystem ? Math.min(at + 100, firstQueuedAt + 250) : reconcileAt ?? at + 250;
		if (pending && (pending.readyAt <= at || !filesystem)) { readyAt = Math.min(readyAt, pending.readyAt); }
		event('reviewed.queued', {
			...this.fileFields(file), trigger, forceSaved: force, coalesced: this.queued.has(file),
			passRunning: this.running, queuedCount: this.queued.size + (this.queued.has(file) ? 0 : 1),
			delayMs: Math.max(0, readyAt - at), maxWaitMs: filesystem ? 250 : undefined,
		});
		this.queued.set(file, { forceSaved: force || !!pending?.forceSaved, firstQueuedAt, readyAt });
		this.states.set(file, { ...this.states.get(file), pending: true, error: undefined });
		this.schedule(readyAt);
		this.changed();
	}

	private schedule(nextReadyAt?: number): void {
		if (this.disposed || this.running || !this.queued.size) { return; }
		let readyAt = nextReadyAt ?? Infinity;
		if (nextReadyAt === undefined) {
			for (const entry of this.queued.values()) { readyAt = Math.min(readyAt, entry.readyAt); }
		}
		// An earlier wake-up may find a postponed filesystem burst; it will reschedule without I/O.
		if (this.timer && this.timerAt !== undefined && this.timerAt <= readyAt) { return; }
		if (this.timer) { clearTimeout(this.timer); }
		this.timerAt = readyAt;
		this.timer = setTimeout(() => {
			this.timer = undefined; this.timerAt = undefined;
			void this.drain();
		}, Math.max(0, Math.ceil(readyAt - now())));
	}

	private ensureCurrent(context: SnapshotContext, file: string, version: number): void {
		if (this.disposed || this.key !== context.key || (this.versions.get(file) ?? 0) !== version) {
			throw new OvertakenReview('The file or comparison changed. Refresh and try again.');
		}
	}

	private failure(error: unknown, fields: Fields = {}): void {
		event('reviewed.failed', { ...fields, ...errorFields(error) });
		const message = error instanceof Error ? error.message : String(error);
		this.log(`Reviewed-state validation failed: ${message}`);
		void vscode.window.showWarningMessage(`Lighthouse: ${message} Use Refresh to retry reviewed-state validation.`);
	}

	private async drain(): Promise<void> {
		if (this.running || this.disposed) { return; }
		this.running = true;
		try {
			while (this.queued.size && !this.disposed) {
				const context = this.context();
				if (!context || context.key !== this.adoptedKey) { this.queued.clear(); break; }
				const ready = now();
				const work = [...this.queued].filter(([, entry]) => entry.readyAt <= ready);
				if (!work.length) { break; }
				for (const [file] of work) { this.queued.delete(file); }
				const fields = { comparisonGeneration: this.comparisonGeneration, passId: ++this.nextPassId };
				const started = now();
				const counts = { kept: 0, invalidated: 0, failed: 0, discarded: 0, legacyCleared: 0 };
				let stage = 'migration';
				event('reviewed.passStarted', {
					...fields, fileCount: work.length, forcedCount: work.filter(([, entry]) => entry.forceSaved).length,
					oldestQueuedMs: work.reduce((oldest, [, entry]) => Math.max(oldest, started - entry.firstQueuedAt), 0),
				});
				try {
					const active = this.getActive();
					if (active?.review?.reviewedFiles?.some((file) => !active.review?.reviewedFileSnapshots?.[file])) {
						const result = await updateReview(context.file, (review) => clearLegacyReviewedFiles(review), {
							beforeWrite: () => { if (this.key !== context.key) { throw new OvertakenReview(); } },
						});
						await active.reloadReview();
						counts.legacyCleared = result.value;
						event('reviewed.legacyCleared', { ...fields, count: result.value });
						if (result.value) {
							void vscode.window.showInformationMessage('Lighthouse: previous reviewed checkmarks were cleared because they had no content fingerprints. Review those files again to begin tracking changes.');
						}
					}
					const files = work.map(([file]) => file).filter((file) => this.getActive()?.review?.reviewedFiles?.includes(file));
					stage = 'prepare';
					await trace('reviewed.prepare', () => this.reader.prepare(context, files), { ...fields, fileCount: files.length });
					for (const [file, entry] of work) {
						const force = entry.forceSaved;
						if (this.key !== context.key) { throw new OvertakenReview(); }
						const fileFields = { ...this.fileFields(file), passId: fields.passId };
						const expected = this.getActive()?.review?.reviewedFileSnapshots?.[file];
						if (!expected || !this.getActive()?.review?.reviewedFiles?.includes(file)) {
							this.states.delete(file);
							event('reviewed.validationSkipped', { ...fileFields, reason: 'uncheckedOrLegacy' });
							continue;
						}
						const version = this.versions.get(file) ?? 0;
						let fileStage = 'snapshot';
						try {
							const snapshot = await trace('reviewed.snapshot', () => this.reader.read(context, file, force), {
								...fileFields, forceSaved: force, working: context.working, version,
							});
							this.ensureCurrent(context, file, version);
							const leftChanged = !sameReviewedSnapshot({ ...expected, right: snapshot.right }, snapshot);
							const rightChanged = !sameReviewedSnapshot({ ...expected, left: snapshot.left }, snapshot);
							event('reviewed.compared', {
								...fileFields, leftChanged, rightChanged, match: !leftChanged && !rightChanged,
								leftKindChanged: expected.left.kind !== snapshot.left.kind,
								rightKindChanged: expected.right.kind !== snapshot.right.kind,
								leftModeChanged: expected.left.kind !== 'absent' && snapshot.left.kind !== 'absent' && expected.left.mode !== snapshot.left.mode,
								rightModeChanged: expected.right.kind !== 'absent' && snapshot.right.kind !== 'absent' && expected.right.mode !== snapshot.right.mode,
							});
							if (leftChanged || rightChanged) {
								fileStage = 'persist';
								const result = await trace('reviewed.persist', () => updateReview(context.file, (review) => {
									const current = review.reviewedFileSnapshots?.[file];
									if (!current || !sameReviewedSnapshot(current, expected)) { return false; }
									setFileReviewed(review, file);
									return true;
								}, { beforeWrite: () => this.ensureCurrent(context, file, version) }), fileFields);
								fileStage = 'reload';
								await this.getActive()?.reloadReview();
								this.ensureCurrent(context, file, version);
								if (result.value) {
									counts.invalidated++;
									event('reviewed.invalidated', { ...fileFields, leftChanged, rightChanged });
									if (diagnosticsEnabled()) {
										this.log(`[reviewed] comparison=${fileFields.comparisonGeneration} fileId=${fileFields.fileId} outcome=unchecked leftChanged=${leftChanged} rightChanged=${rightChanged}`);
									}
								} else {
									counts.discarded++;
									event('reviewed.validationSkipped', { ...fileFields, reason: 'newerCheck' });
									if (this.getActive()?.review?.reviewedFiles?.includes(file)) { this.enqueue(file, false, 'newer-check'); }
								}
							} else {
								counts.kept++; event('reviewed.kept', fileFields);
							}
							this.states.set(file, { pending: this.queued.has(file), signature: JSON.stringify(snapshot) });
						} catch (error) {
							if (error instanceof OvertakenReview) {
								counts.discarded++;
								event('reviewed.overtaken', { ...fileFields, stage: fileStage });
								continue;
							}
							counts.failed++;
							this.states.set(file, { pending: false, error: error instanceof Error ? error.message : String(error) });
							this.failure(error, { ...fileFields, stage: fileStage });
						}
					}
					if (this.key === context.key) { this.syncWatches(context); }
				} catch (error) {
					if (!(error instanceof OvertakenReview)) {
						counts.failed++;
						if (this.key === context.key) {
							for (const [file] of work) { this.states.set(file, { pending: false, error: error instanceof Error ? error.message : String(error) }); }
						}
						this.failure(error, { ...fields, stage });
					} else {
						counts.discarded++;
						event('reviewed.overtaken', { ...fields, stage });
					}
				} finally {
					event('reviewed.passFinished', { ...fields, ...counts, durationMs: now() - started, queuedCount: this.queued.size });
				}
				this.changed();
			}
		} finally { this.running = false; this.schedule(); }
	}

	async setReviewed(file: string, checked: boolean, key: string): Promise<void> {
		const fields = { ...this.fileFields(file), checked };
		try {
			const availability = isReviewFilePath(file) ? this.availability(file) : undefined;
			event('reviewed.actionRequested', {
				...fields, dirty: availability?.dirty, pending: availability?.pending, currentComparison: key === this.key,
			});
			await trace('reviewed.action', () => this.applyReviewed(file, checked, key), fields);
			event('reviewed.actionCompleted', fields);
			if (diagnosticsEnabled()) {
				this.log(`[reviewed] comparison=${fields.comparisonGeneration} fileId=${fields.fileId} outcome=${checked ? 'checked' : 'unchecked'} action=user`);
			}
		} catch (error) {
			event('reviewed.actionFailed', { ...fields, ...errorFields(error), overtaken: error instanceof OvertakenReview });
			this.log(`Reviewed-state action failed: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}

	private async applyReviewed(file: string, checked: boolean, key: string): Promise<void> {
		const context = this.context(), active = this.getActive();
		if (!context || !active?.review || key !== context.key) { throw new Error('The comparison changed. Refresh before changing reviewed state.'); }
		reviewFileAbsolute(context.root, file);
		if (this.availability(file).dirty) { throw new Error('Save or discard unsaved changes before changing reviewed state.'); }
		if (this.availability(file).pending) { throw new Error('Reviewed-state validation is still pending.'); }
		const token = Symbol();
		this.checking.set(file, { key: context.key, token });
		this.states.set(file, { ...this.states.get(file), pending: true });
		this.syncWatches(context); this.changed();
		const version = this.versions.get(file) ?? 0;
		const verify = (): void => {
			this.ensureCurrent(context, file, version);
			if (this.availability(file).dirty) { throw new Error('Save or discard unsaved changes before changing reviewed state.'); }
		};
		try {
			// ASSUMPTION: this certifies the complete saved comparison, even from a split-view row.
			const snapshot = checked ? await trace('reviewed.snapshot', () => this.reader.read(context, file), {
				...this.fileFields(file), working: context.working, forceSaved: true,
			}) : undefined;
			verify();
			await updateReview(context.file, (review) => { verify(); setFileReviewed(review, file, snapshot); }, {
				seed: active.review.threads.length === 0 && !active.review.reviewedFiles?.length ? active.review : undefined,
				beforeWrite: verify,
			});
			await active.reloadReview();
			this.ensureCurrent(context, file, version);
			this.states.set(file, { pending: false, signature: snapshot && JSON.stringify(snapshot) });
		} catch (error) {
			if (this.key === context.key) {
				this.states.set(file, { pending: false, error: error instanceof Error ? error.message : String(error) });
			}
			throw error;
		} finally {
			if (this.checking.get(file)?.token === token) { this.checking.delete(file); }
			if (this.key === context.key) { this.syncWatches(context); }
			this.changed();
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) { clearTimeout(this.timer); }
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.reader.dispose();
		this.clear();
	}
}
