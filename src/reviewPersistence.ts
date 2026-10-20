import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as lockfile from 'proper-lockfile';
import { Review, parseReview } from './reviewModel';
import { serializeReview, validateReviewDocument } from './reviewCore';

export type OwnedOperation<T> = (assertOwned: () => void) => Promise<T>;
export interface ReviewIO {
	read(file: string): Promise<string | undefined>;
	mkdir(directory: string): Promise<void>;
	write(file: string, text: string): Promise<void>;
	rename(source: string, target: string): Promise<void>;
	remove(file: string): Promise<void>;
	prepare?(temporary: string, target: string): Promise<void>;
	lock<T>(file: string, operation: OwnedOperation<T>): Promise<T>;
}

export function missing(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error &&
		(error.code === 'ENOENT' || error.code === 'FileNotFound');
}

export const nodeReviewIO: ReviewIO = {
	async read(file) { try { return await fs.readFile(file, 'utf8'); } catch (error) { if (missing(error)) { return undefined; } throw error; } },
	async mkdir(directory) { await fs.mkdir(directory, { recursive: true }); },
	async write(file, text) { await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); },
	async rename(source, target) { await fs.rename(source, target); },
	async remove(file) { try { await fs.unlink(file); } catch (error) { if (!missing(error)) { throw error; } } },
	async prepare(temporary, target) {
		// Atomic replacement must not widen existing POSIX permissions, particularly for CLI configurations.
		try { await fs.chmod(temporary, (await fs.stat(target)).mode & 0o777); }
		catch (error) { if (!missing(error)) { throw error; } }
	},
	lock: withReviewFileLock,
};

const tails = new Map<string, Promise<void>>();

export function queueFileOperation<T>(file: string, operation: () => Promise<T>): Promise<T> {
	const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
	const result = (tails.get(key) ?? Promise.resolve()).then(operation);
	const tail = result.then(() => undefined, () => undefined);
	tails.set(key, tail);
	void tail.then(() => { if (tails.get(key) === tail) { tails.delete(key); } });
	return result;
}

export async function withReviewFileLock<T>(file: string, operation: OwnedOperation<T>, createParent = true): Promise<T> {
	if (createParent) { await fs.mkdir(path.dirname(file), { recursive: true }); }
	const parent = await fs.realpath(path.dirname(file));
	const canonical = path.join(parent, path.basename(file));
	try {
		if ((await fs.lstat(canonical)).isSymbolicLink()) { throw new Error('Review writes cannot replace a symbolic link.'); }
	} catch (error) { if (!missing(error)) { throw error; } }
	let compromised: Error | undefined;
	const release = await lockfile.lock(canonical, {
		realpath: false, stale: 10000, update: 2000,
		retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 25 },
		onCompromised: (error) => { compromised = error; },
	});
	try {
		const result = await operation(() => { if (compromised) { throw compromised; } });
		if (compromised) { throw compromised; }
		return result;
	} finally {
		if (!compromised) { await release(); }
	}
}

export async function atomicReviewWrite(file: string, text: string, io: ReviewIO, beforeCommit: () => Promise<void>): Promise<void> {
	await io.mkdir(path.dirname(file));
	const temporary = path.join(path.dirname(file), `.comments-${randomUUID()}.tmp`);
	let written = false;
	let failure: unknown;
	try {
		await io.write(temporary, text);
		await io.prepare?.(temporary, file);
		await beforeCommit();
		await io.rename(temporary, file);
		written = true;
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		if (!written) {
			try { await io.remove(temporary); }
			catch (cleanup) { throw new AggregateError(failure ? [failure, cleanup] : [cleanup], 'The write failed and its temporary file could not be removed.'); }
		}
	}
}

export interface UpdateOptions {
	seed?: Review;
	beforeWrite?: () => void | Promise<void>;
	io?: ReviewIO;
}

export function updateReviewFile<T>(file: string, mutate: (review: Review, raw: string) => T | Promise<T>,
	options: UpdateOptions = {}): Promise<{ review: Review; value: T }> {
	const io = options.io ?? nodeReviewIO;
	return queueFileOperation(file, () => io.lock(file, async (assertOwned) => {
		const raw = await io.read(file);
		const text = raw ?? (options.seed ? JSON.stringify(serializeReview(options.seed)) : undefined);
		if (text === undefined) { throw new Error('The saved review is missing. Refresh before trying again.'); }
		const original: unknown = JSON.parse(text);
		validateReviewDocument(original);
		const review = parseReview(text, file);
		if (!review) { throw new Error('The saved review is invalid. Refresh before trying again.'); }
		const before = JSON.stringify(review);
		const value = await mutate(review, text);
		if (JSON.stringify(review) !== before || raw === undefined) {
			await atomicReviewWrite(file, JSON.stringify(serializeReview(review, original), null, 2) + '\n', io, async () => {
				await options.beforeWrite?.();
				assertOwned();
				// ASSUMPTION: the lock coordinates cooperating writers; this additionally detects observed manual edits.
				if (await io.read(file) !== raw) { throw new Error('The review changed while saving. Refresh and try again.'); }
			});
		}
		return { review, value };
	}));
}

export function saveReviewFile(review: Review, beforeWrite?: () => Promise<void>, io: ReviewIO = nodeReviewIO): Promise<void> {
	return queueFileOperation(review.sourceFile, () => io.lock(review.sourceFile, async (assertOwned) => {
		const raw = await io.read(review.sourceFile);
		const original: unknown = raw === undefined ? undefined : JSON.parse(raw);
		if (original !== undefined) { validateReviewDocument(original); }
		await atomicReviewWrite(review.sourceFile, JSON.stringify(serializeReview(review, original), null, 2) + '\n', io, async () => {
			await beforeWrite?.();
			assertOwned();
			if (await io.read(review.sourceFile) !== raw) { throw new Error('The review changed while saving. Refresh and try again.'); }
		});
	}));
}
