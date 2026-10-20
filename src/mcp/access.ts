import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { isReviewFilePath, parseReview, Review } from '../reviewModel';
import { record, validateReviewDocument } from '../reviewCore';
import { missing } from '../reviewPersistence';

export const MAX_REVIEW_BYTES = 16 * 1024 * 1024;
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export class ReviewError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
}

export function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

export async function readBounded(file: string): Promise<string | undefined> {
	let handle;
	try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
	catch (error) { if (missing(error)) { return undefined; } throw error; }
	try {
		if (!(await handle.stat()).isFile()) { throw new ReviewError('INVALID_REVIEW_FILE', 'Review data must be a regular file.'); }
		const chunks: Buffer[] = [];
		let length = 0;
		for (;;) {
			const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_REVIEW_BYTES + 1 - length));
			const { bytesRead } = await handle.read(buffer);
			if (!bytesRead) { break; }
			length += bytesRead;
			if (length > MAX_REVIEW_BYTES) { throw new ReviewError('REVIEW_TOO_LARGE', 'Review files are limited to 16 MiB.'); }
			chunks.push(buffer.subarray(0, bytesRead));
		}
		return Buffer.concat(chunks).toString('utf8');
	} finally { await handle.close(); }
}

export interface SavedReview { review: Review; raw: string; revision: string }

export function parseSaved(raw: string, file: string): SavedReview {
	let document: unknown;
	try {
		document = JSON.parse(raw);
		validateReviewDocument(document);
		const strings = (object: Record<string, unknown>, keys: string[]) => {
			if (keys.some((key) => object[key] !== undefined && typeof object[key] !== 'string')) { throw new Error(); }
		};
		strings(document, ['sourceBranch', 'targetBranch', 'sourceCommit', 'targetCommit']);
		if (document.seqCounter !== undefined && (!Number.isSafeInteger(document.seqCounter) || Number(document.seqCounter) < 0)) { throw new Error(); }
		if (document.reviewedFiles !== undefined && (!Array.isArray(document.reviewedFiles) || document.reviewedFiles.some((item) => typeof item !== 'string'))) { throw new Error(); }
		const ids = new Set<string>();
		for (const thread of document.threads) {
			strings(thread, ['id', 'title', 'filePath', 'state', 'anchorText']);
			for (const field of ['seq', 'startLine', 'endLine']) {
				if (thread[field] !== undefined && (!Number.isSafeInteger(thread[field]) || Number(thread[field]) < 1)) { throw new Error(); }
			}
			if (thread.state !== undefined && thread.state !== 'resolved' && thread.state !== 'unresolved') { throw new Error(); }
			if (typeof thread.id === 'string' && (ids.has(thread.id) || !thread.id)) { throw new Error(); }
			if (typeof thread.id === 'string') { ids.add(thread.id); }
			const comments = thread.comments as unknown[];
			const commentIds = new Set<string>();
			for (const comment of comments) {
				if (!record(comment)) { throw new Error(); }
				strings(comment, ['id', 'timestamp', 'replyTo']);
				if (typeof comment.id === 'string' && (commentIds.has(comment.id) || !comment.id)) { throw new Error(); }
				if (typeof comment.id === 'string') { commentIds.add(comment.id); }
				if (comment.tags !== undefined && (!Array.isArray(comment.tags) || comment.tags.some((tag) => typeof tag !== 'string'))) { throw new Error(); }
				if (record(comment.author)) { strings(comment.author, ['kind', 'name', 'model', 'reasoning', 'version', 'sessionId']); }
			}
		}
	}
	catch { throw new ReviewError('INVALID_REVIEW', 'The saved review is invalid or uses an unsupported schema. No data was replaced.'); }
	const review = parseReview(raw, file);
	if (!review) { throw new ReviewError('INVALID_REVIEW', 'The saved review cannot be parsed.'); }
	if (record(document) && document.reviewedFileSnapshots !== undefined) {
		if (!record(document.reviewedFileSnapshots) ||
			Object.keys(document.reviewedFileSnapshots).some((key) => !review.reviewedFileSnapshots?.[key])) {
			throw new ReviewError('INVALID_REVIEW', 'The saved review contains unsupported or invalid checklist snapshots. No fields were discarded.');
		}
	}
	return { review, raw, revision: hash(raw) };
}

export class ReviewAccess {
	private rootPromise?: Promise<string>;
	constructor(private readonly launchDirectory: string) {}

	root(): Promise<string> {
		return this.rootPromise ??= (async () => {
			try {
				// ASSUMPTION: the CLI starts stdio servers in its session cwd; never chdir to the installed payload.
				const { stdout } = await promisify(execFile)('git', ['-C', this.launchDirectory, 'rev-parse', '--show-toplevel'], {
					encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024,
				});
				return await fs.realpath(stdout.trim());
			} catch {
				throw new ReviewError('NO_WORKTREE', 'Start this MCP server from the CLI session in a disk-backed Git worktree, then restart the connection.');
			}
		})();
	}

	async workspace(relative = '.'): Promise<string> {
		const root = await this.root();
		if (relative !== '.' && !isReviewFilePath(relative)) { throw new ReviewError('INVALID_WORKSPACE', 'Workspace must be a relative directory inside this session worktree.'); }
		const candidate = path.resolve(root, relative);
		const physical = await fs.realpath(candidate);
		if (!within(root, physical)) { throw new ReviewError('OUTSIDE_WORKTREE', 'The workspace leaves this session worktree.'); }
		return physical;
	}

	async safe(workspace: string, relative: string): Promise<string> {
		const target = path.join(workspace, ...relative.split('/'));
		if (!within(workspace, target)) { throw new ReviewError('OUTSIDE_WORKTREE', 'The review path leaves this workspace.'); }
		let current = workspace;
		for (const part of relative.split('/')) {
			current = path.join(current, part);
			try {
				if ((await fs.lstat(current)).isSymbolicLink()) { throw new ReviewError('LINKED_REVIEW', 'Linked review-store paths are not supported.'); }
			} catch (error) { if (missing(error)) { break; } throw error; }
		}
		return target;
	}

	async file(workspace: string, reviewId: string): Promise<string> {
		const nameMatches = process.platform === 'win32' ? /(^|\/)comments\.json$/i.test(reviewId) : /(^|\/)comments\.json$/.test(reviewId);
		if (!isReviewFilePath(reviewId) || !nameMatches) {
			throw new ReviewError('INVALID_REVIEW_ID', 'Use a reviewId returned by list_reviews, not an absolute file path.');
		}
		return this.safe(workspace, `.vscode/lighthouse-reviews/${reviewId}`);
	}

	async load(workspace: string, reviewId: string): Promise<SavedReview> {
		const file = await this.file(workspace, reviewId);
		const raw = await readBounded(file);
		if (raw === undefined) { throw new ReviewError('REVIEW_NOT_FOUND', 'The selected saved review no longer exists.'); }
		return parseSaved(raw, file);
	}

	async discover(workspace: string): Promise<{ ids: string[]; issues: { reviewId: string; code: string }[] }> {
		const root = await this.safe(workspace, '.vscode/lighthouse-reviews');
		const directories = [root], ids: string[] = [], issues: { reviewId: string; code: string }[] = [];
		let visited = 0;
		while (directories.length) {
			if (++visited > 10000) { throw new ReviewError('DISCOVERY_LIMIT', 'The review store exceeds the 10,000-directory discovery bound.'); }
			const directory = directories.pop()!;
			await this.safe(workspace, path.relative(workspace, directory).split(path.sep).join('/'));
			let entries;
			try { entries = await fs.readdir(directory, { withFileTypes: true }); }
			catch (error) { if (missing(error)) { continue; } throw error; }
			for (const entry of entries) {
				const file = path.join(directory, entry.name);
				const id = path.relative(root, file).split(path.sep).join('/');
				if (entry.isSymbolicLink()) { issues.push({ reviewId: id, code: 'LINKED_REVIEW' }); }
				else if (entry.isDirectory()) { directories.push(file); }
				else if (entry.isFile() && (process.platform === 'win32' ? entry.name.toLowerCase() : entry.name) === 'comments.json') {
					ids.push(id);
					if (ids.length > 10000) { throw new ReviewError('DISCOVERY_LIMIT', 'The review store exceeds 10,000 files.'); }
				}
			}
		}
		return { ids: ids.sort(), issues };
	}
}
