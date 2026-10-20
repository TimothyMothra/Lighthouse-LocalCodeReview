/**
 * VS Code adapter for review discovery and shared, coordinated v2 persistence.
 * The standalone MCP server uses the same model/core without importing this module.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { Review, parseReview } from './reviewModel';
import { event, trace } from './diagnostics';
import { missing, ReviewIO, saveReviewFile, updateReviewFile, withReviewFileLock } from './reviewPersistence';
export { newId, serializeReview, humanAuthor, addComment, addReply, setThreadState, addThreadTags, addThread, addGeneralThread } from './reviewCore';

/** ASSUMPTION: existing stores are moved once by the user; discovery uses only the Lighthouse namespace. */
export const REVIEWS_GLOB = '.vscode/lighthouse-reviews/**/comments.json';
const discoveryInFlight = new Map<string, Promise<vscode.Uri[]>>();

export async function readReviewText(file: string): Promise<string | undefined> {
	try { return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(file))).toString('utf8'); }
	catch (error) { if (missing(error)) { return undefined; } throw error; }
}

const io: ReviewIO = {
	read: readReviewText,
	async mkdir(directory) { await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory)); },
	async write(file, text) { await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(text, 'utf8')); },
	async rename(source, target) { await vscode.workspace.fs.rename(vscode.Uri.file(source), vscode.Uri.file(target), { overwrite: true }); },
	async remove(file) {
		try { await vscode.workspace.fs.delete(vscode.Uri.file(file)); }
		catch (error) { if (!missing(error)) { throw error; } }
	},
	lock: withReviewFileLock,
};

export function updateReview<T>(file: string, mutate: (review: Review) => T | Promise<T>,
	options: { seed?: Review; beforeWrite?: () => void | Promise<void> } = {}): Promise<{ review: Review; value: T }> {
	return updateReviewFile(file, mutate, { ...options, io });
}

export function saveReview(review: Review, beforeWrite?: () => Promise<void>): Promise<void> {
	return saveReviewFile(review, beforeWrite, io);
}

function discoverReviews(folder: vscode.Uri): Promise<vscode.Uri[]> {
	const root = vscode.Uri.joinPath(folder, '.vscode', 'lighthouse-reviews');
	const key = root.toString();
	const existing = discoveryInFlight.get(key);
	if (existing) {
		event('reviews.discoveryCache', { outcome: 'join' });
		return trace('reviews.discoverWait', () => existing);
	}
	event('reviews.discoveryCache', { outcome: 'miss' });
	const pending = trace('reviews.discover', async () => {
		const files: vscode.Uri[] = [];
		const directories = [root];
		let directoryCount = 0, skippedLinks = 0;
		while (directories.length) {
			const directory = directories.pop()!;
			let entries: [string, vscode.FileType][];
			try { entries = await trace('reviews.readDirectory', async () => vscode.workspace.fs.readDirectory(directory)); }
			catch (error) {
				if (!missing(error)) { throw error; }
				event('reviews.directoryMissing');
				continue;
			}
			directoryCount++;
			for (const [name, type] of entries) {
				// ASSUMPTION: stores are ordinary directories; do not follow links into other repositories or cycles.
				if ((type & vscode.FileType.SymbolicLink) && !(type & vscode.FileType.File)) { skippedLinks++; continue; }
				const uri = vscode.Uri.joinPath(directory, name);
				if (type & vscode.FileType.Directory) { directories.push(uri); }
				else if ((type & vscode.FileType.File) && (process.platform === 'win32' ? name.toLowerCase() : name) === 'comments.json') { files.push(uri); }
			}
		}
		event('reviews.discovered', { fileCount: files.length, directoryCount, skippedLinks });
		return files;
	}).finally(() => { if (discoveryInFlight.get(key) === pending) { discoveryInFlight.delete(key); } });
	discoveryInFlight.set(key, pending);
	return pending;
}

export async function scanReviews(): Promise<Review[]> {
	return trace('reviews.scan', async () => {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const found: Review[] = [];
		let fileCount = 0;
		event('reviews.scanStarted', { folderCount: folders.length });
		for (const folder of folders) {
			const uris = await discoverReviews(folder.uri);
			fileCount += uris.length;
			for (const uri of uris) { const review = await loadReview(uri); if (review) { found.push(review); } }
		}
		found.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
		event('reviews.scanResult', { fileCount, reviewCount: found.length, skippedCount: fileCount - found.length });
		return found;
	});
}

export async function loadReview(uri: vscode.Uri): Promise<Review | undefined> {
	return trace('reviews.load', async () => {
		let phase = 'read';
		try {
			const bytes = await trace('reviews.read', async () => vscode.workspace.fs.readFile(uri));
			phase = 'parse';
			return await trace('reviews.parse', async () => {
				const review = parseReview(Buffer.from(bytes).toString('utf8'), uri.fsPath);
				event('reviews.loadResult', {
					outcome: review ? 'loaded' : 'invalidParse', byteCount: bytes.byteLength,
					threadCount: review?.threads.length, commentCount: review?.threads.reduce((count, thread) => count + thread.comments.length, 0),
				});
				return review;
			});
		} catch (error) {
			event('reviews.loadResult', { outcome: phase === 'read' && missing(error) ? 'missing' : 'error', phase });
			return undefined;
		}
	});
}

export function computeReviewPaths(workspaceFolderFsPath: string, compare: string, base: string): { reviewDir: string; sourceFile: string } {
	const reviewDir = path.join(workspaceFolderFsPath, '.vscode', 'lighthouse-reviews', `${compare.replace(/\//g, '-')}_${base.replace(/\//g, '-')}`);
	return { reviewDir, sourceFile: path.join(reviewDir, 'comments.json') };
}

export function emptyReview(workspaceFolderFsPath: string, compare: string, base: string, compareCommit?: string, baseCommit?: string): Review {
	return {
		version: 2, sourceBranch: compare, targetBranch: base, sourceCommit: compareCommit, targetCommit: baseCommit,
		threads: [], reviewedFiles: [], seqCounter: 0, sourceFile: computeReviewPaths(workspaceFolderFsPath, compare, base).sourceFile,
	};
}
