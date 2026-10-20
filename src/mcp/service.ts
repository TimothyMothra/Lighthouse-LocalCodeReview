import { Review, ReviewAuthor, ReviewThread } from '../reviewModel';
import { serializeComment } from '../reviewCore';
import { nodeReviewIO, updateReviewFile, withReviewFileLock } from '../reviewPersistence';
import { hash, MAX_REVIEW_BYTES, parseSaved, readBounded, ReviewAccess, ReviewError, SavedReview } from './access';

export interface PageInput { workspace?: string; limit?: number; cursor?: string }
export interface ReviewInput extends PageInput { reviewId: string }
export interface ThreadInput extends ReviewInput { threadId: string }
export interface ReplyInput extends ThreadInput {
	body: string; replyTo?: string; author: ReviewAuthor; expectedRevision: string; requestId: string;
}

function page<T>(items: T[], input: PageInput, context: string, revision: string): { items: T[]; nextCursor?: string; total: number } {
	const limit = input.limit ?? 50;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) { throw new ReviewError('INVALID_LIMIT', 'Page size must be between 1 and 200.'); }
	let offset = 0;
	if (input.cursor) {
		try {
			if (input.cursor.length > 4096) { throw new Error(); }
			const cursor: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
			if (typeof cursor !== 'object' || cursor === null || !('context' in cursor) || cursor.context !== context ||
				!('revision' in cursor) || cursor.revision !== revision || !('offset' in cursor) ||
				typeof cursor.offset !== 'number' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > items.length) { throw new Error(); }
			offset = cursor.offset;
		} catch { throw new ReviewError('STALE_CURSOR', 'This cursor is invalid or the saved data changed. Start again without a cursor.'); }
	}
	const end = Math.min(items.length, offset + limit);
	return {
		items: items.slice(offset, end), total: items.length,
		...(end < items.length ? { nextCursor: Buffer.from(JSON.stringify({ context, revision, offset: end })).toString('base64url') } : {}),
	};
}

function metadata(review: Review) {
	return { sourceBranch: review.sourceBranch, targetBranch: review.targetBranch, sourceCommit: review.sourceCommit, targetCommit: review.targetCommit };
}

function threadKey(thread: ReviewThread, index: number): string {
	return thread.id ?? `legacy:${index}:${hash(JSON.stringify(thread))}`;
}

function threadInfo(thread: ReviewThread, index: number) {
	const initial: string[] = [];
	for (const character of thread.comments[0]?.body ?? '') {
		initial.push(character);
		if (initial.length > 64) { break; }
	}
	return {
		threadId: threadKey(thread, index), storedThreadId: thread.id ?? null, writable: !!thread.id,
		seq: thread.seq, title: thread.title, filePath: thread.filePath, startLine: thread.startLine, endLine: thread.endLine,
		state: thread.state ?? 'unresolved', tags: thread.tags, commentCount: thread.comments.length,
		initialAuthor: thread.comments[0]?.author,
		initialCommentPreview: initial.slice(0, 64).join(''), initialCommentPreviewTruncated: initial.length > 64,
	};
}

function selectedThread(saved: SavedReview, key: string): { thread: ReviewThread; index: number } {
	const matches = saved.review.threads.map((thread, index) => ({ thread, index }))
		.filter(({ thread, index }) => threadKey(thread, index) === key);
	if (matches.length !== 1) { throw new ReviewError('THREAD_NOT_FOUND', 'The thread is missing, ambiguous, or its legacy snapshot changed. Read the review again.'); }
	return matches[0];
}

function normalizeAuthor(author: ReviewAuthor): ReviewAuthor {
	if (author.kind !== 'agent' || !author.name?.trim()) { throw new ReviewError('INVALID_AUTHOR', 'Replies require kind agent and a nonblank agent name.'); }
	return {
		kind: 'agent', name: author.name,
		...(author.model ? { model: author.model } : {}), ...(author.reasoning ? { reasoning: author.reasoning } : {}),
		...(author.version ? { version: author.version } : {}), ...(author.sessionId ? { sessionId: author.sessionId } : {}),
	};
}

export class ReviewService {
	readonly access: ReviewAccess;
	constructor(launchDirectory: string) { this.access = new ReviewAccess(launchDirectory); }

	async listReviews(input: PageInput) {
		const workspaceRoot = await this.access.workspace(input.workspace);
		const found = await this.access.discover(workspaceRoot);
		const issues = [...found.issues];
		const reviews = [];
		for (const reviewId of found.ids) {
			try {
				const saved = await this.access.load(workspaceRoot, reviewId);
				reviews.push({
					reviewId, ...metadata(saved.review), revision: saved.revision,
					threadCount: saved.review.threads.length,
					commentCount: saved.review.threads.reduce((sum, thread) => sum + thread.comments.length, 0),
				});
			} catch (error) { issues.push({ reviewId, code: error instanceof ReviewError ? error.code : 'READ_FAILED' }); }
		}
		issues.sort((left, right) => left.reviewId.localeCompare(right.reviewId));
		const revision = hash(JSON.stringify({ reviews, issues }));
		return { workspaceRoot, revision, complete: issues.length === 0, issues, ...page(reviews, input, `${workspaceRoot}:reviews`, revision) };
	}

	async getReview(input: ReviewInput) {
		const workspaceRoot = await this.access.workspace(input.workspace);
		const saved = await this.access.load(workspaceRoot, input.reviewId);
		const threads = saved.review.threads.map(threadInfo);
		return {
			workspaceRoot, reviewId: input.reviewId, revision: saved.revision, ...metadata(saved.review),
			...page(threads, input, `${workspaceRoot}:${input.reviewId}:threads`, saved.revision),
		};
	}

	async getThread(input: ThreadInput) {
		const workspaceRoot = await this.access.workspace(input.workspace);
		const saved = await this.access.load(workspaceRoot, input.reviewId);
		const { thread, index } = selectedThread(saved, input.threadId);
		return {
			workspaceRoot, reviewId: input.reviewId, revision: saved.revision, ...threadInfo(thread, index),
			...page(thread.comments, input, `${workspaceRoot}:${input.reviewId}:${input.threadId}`, saved.revision),
		};
	}

	async reply(input: ReplyInput) {
		if (!input.body.trim() || Buffer.byteLength(input.body, 'utf8') > 65536) { throw new ReviewError('INVALID_BODY', 'Reply bodies must be nonblank and at most 64 KiB UTF-8.'); }
		if (!input.requestId.trim() || input.requestId.length > 256) { throw new ReviewError('INVALID_REQUEST_ID', 'Supply a unique requestId of at most 256 characters; reuse it only when retrying this reply.'); }
		const author = normalizeAuthor(input.author);
		const workspaceRoot = await this.access.workspace(input.workspace);
		const before = await this.access.load(workspaceRoot, input.reviewId);
		const file = before.review.sourceFile;
		const fileKey = process.platform === 'win32' ? file.toLowerCase() : file;
		const id = `c-mcp-${hash(JSON.stringify([fileKey, input.threadId, input.requestId]))}`;
		const result = await updateReviewFile(file, (review, raw) => {
			parseSaved(raw, file);
			const { thread } = selectedThread({ review, raw, revision: hash(raw) }, input.threadId);
			if (!thread.id) { throw new ReviewError('LEGACY_READ_ONLY', 'This thread has no persisted ID and cannot be safely mutated through MCP.'); }
			const existing = thread.comments.filter((comment) => comment.id === id);
			if (existing.length > 1) { throw new ReviewError('DUPLICATE_ID', 'The saved review contains duplicate reply IDs.'); }
			if (existing[0]) {
				const comment = existing[0];
				if (comment.body !== input.body || (input.replyTo !== undefined && input.replyTo !== comment.replyTo) ||
					JSON.stringify(normalizeAuthor(comment.author ?? { kind: '', name: '' })) !== JSON.stringify(author)) {
					throw new ReviewError('REQUEST_CONFLICT', 'This requestId already identifies a different reply.');
				}
				return { comment, replayed: true };
			}
			if (hash(raw) !== input.expectedRevision) { throw new ReviewError('REVISION_CONFLICT', 'The saved review changed. Read the thread again before replying.'); }
			const parent = input.replyTo ?? thread.comments.at(-1)?.id;
			if ((input.replyTo !== undefined && thread.comments.filter((comment) => comment.id === parent).length !== 1) ||
				(input.replyTo === undefined && thread.comments.length > 0 && (!parent || thread.comments.filter((comment) => comment.id === parent).length !== 1))) {
				throw new ReviewError('INVALID_PARENT', 'The parent comment must have a unique persisted ID in this thread.');
			}
			const comment = { id, body: input.body, author, timestamp: new Date().toISOString(), ...(parent ? { replyTo: parent } : {}) };
			thread.comments.push(comment);
			return { comment, replayed: false };
		}, {
			io: {
				...nodeReviewIO, read: readBounded,
				async write(target, text) {
					// ASSUMPTION: the full formatted review, including preserved fields, must remain readable by MCP.
					if (Buffer.byteLength(text, 'utf8') > MAX_REVIEW_BYTES) {
						throw new ReviewError('REVIEW_TOO_LARGE', 'This reply would exceed the 16 MiB review-file limit. No reply was saved.');
					}
					await nodeReviewIO.write(target, text);
				},
				lock: (target, operation) => withReviewFileLock(target, operation, false),
			},
			beforeWrite: async () => { await this.access.file(workspaceRoot, input.reviewId); },
		});
		const saved = await this.access.load(workspaceRoot, input.reviewId);
		return {
			workspaceRoot, reviewId: input.reviewId, threadId: input.threadId,
			comment: serializeComment(result.value.comment), replayed: result.value.replayed, revision: saved.revision,
		};
	}
}
