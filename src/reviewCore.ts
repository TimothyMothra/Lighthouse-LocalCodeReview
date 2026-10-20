import { Review, ReviewAuthor, ReviewComment, ReviewThread, normalizeSeq } from './reviewModel';

export function newId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateReviewDocument(value: unknown): asserts value is Record<string, unknown> & { threads: Record<string, unknown>[] } {
	if (!record(value) || (value.version !== undefined && value.version !== 1 && value.version !== 2) ||
		!Array.isArray(value.threads)) {
		throw new Error('The review must contain a supported v1/v2 threads array.');
	}
	for (const thread of value.threads) {
		if (!record(thread) || !Array.isArray(thread.comments) ||
			(thread.id !== undefined && typeof thread.id !== 'string') ||
			(thread.tags !== undefined && (!Array.isArray(thread.tags) || thread.tags.some((tag: unknown) => typeof tag !== 'string')))) {
			throw new Error('The review contains an invalid thread.');
		}
		for (const comment of thread.comments) {
			if (!record(comment) || typeof comment.body !== 'string' ||
				(comment.id !== undefined && typeof comment.id !== 'string') ||
				(comment.replyTo !== undefined && typeof comment.replyTo !== 'string') ||
				(comment.author !== undefined && typeof comment.author !== 'string' && !record(comment.author))) {
				throw new Error('The review contains an invalid comment.');
			}
		}
	}
}

function mergeUnknown(original: unknown, known: string[], current: Record<string, unknown>): Record<string, unknown> {
	// ASSUMPTION: normalized models omit extension fields. Preserve those fields without restoring cleared known fields.
	const extra = record(original) ? Object.fromEntries(Object.entries(original).filter(([key]) => !known.includes(key))) : {};
	return { ...extra, ...current };
}

function originalItem(items: unknown, id: string | undefined, index: number): unknown {
	if (!Array.isArray(items)) { return undefined; }
	return id ? items.find((item) => record(item) && item.id === id) : items[index];
}

function serializeAuthor(author: ReviewAuthor | undefined, original?: unknown): Record<string, unknown> | undefined {
	if (!author) { return undefined; }
	return mergeUnknown(original, ['kind', 'name', 'model', 'reasoning', 'version', 'sessionId'], {
		kind: author.kind, name: author.name,
		...(author.model ? { model: author.model } : {}),
		...(author.reasoning ? { reasoning: author.reasoning } : {}),
		...(author.version ? { version: author.version } : {}),
		...(author.sessionId ? { sessionId: author.sessionId } : {}),
	});
}

export function serializeComment(comment: ReviewComment, original?: unknown): Record<string, unknown> {
	const author = serializeAuthor(comment.author, record(original) ? original.author : undefined);
	return mergeUnknown(original, ['id', 'body', 'timestamp', 'replyTo', 'author', 'tags'], {
		id: comment.id ?? newId('c'), body: comment.body,
		...(comment.timestamp ? { timestamp: comment.timestamp } : {}),
		...(comment.replyTo ? { replyTo: comment.replyTo } : {}),
		...(author ? { author } : {}),
		...(comment.tags?.length ? { tags: comment.tags } : {}),
	});
}

function serializeThread(thread: ReviewThread, original?: unknown): Record<string, unknown> {
	return mergeUnknown(original, ['id', 'title', 'filePath', 'startLine', 'endLine', 'state', 'seq', 'tags', 'anchorText', 'comments'], {
		id: thread.id ?? newId('t'),
		...(thread.title ? { title: thread.title } : {}),
		filePath: thread.filePath, startLine: thread.startLine, endLine: thread.endLine ?? thread.startLine,
		state: thread.state ?? 'unresolved',
		...(thread.seq !== undefined ? { seq: thread.seq } : {}),
		tags: thread.tags,
		...(thread.anchorText !== undefined ? { anchorText: thread.anchorText } : {}),
		comments: thread.comments.map((comment, index) =>
			serializeComment(comment, originalItem(record(original) ? original.comments : undefined, comment.id, index))),
	});
}

function serializeSnapshots(review: Review, original: unknown): Record<string, unknown> | undefined {
	if (!review.reviewedFileSnapshots || !Object.keys(review.reviewedFileSnapshots).length) { return undefined; }
	const raw = record(original) && record(original.reviewedFileSnapshots) ? original.reviewedFileSnapshots : {};
	return Object.fromEntries(Object.entries(review.reviewedFileSnapshots).map(([file, snapshot]) => {
		const previous = record(raw[file]) ? raw[file] : {};
		const side = (value: typeof snapshot.left, old: unknown) => mergeUnknown(old, ['kind', 'hash', 'mode'], { ...value });
		return [file, mergeUnknown(previous, ['version', 'left', 'right'], {
			version: snapshot.version, left: side(snapshot.left, previous.left), right: side(snapshot.right, previous.right),
		})];
	}));
}

export function serializeReview(review: Review, original?: unknown): Record<string, unknown> {
	const snapshots = serializeSnapshots(review, original);
	return mergeUnknown(original, [
		'version', 'sourceBranch', 'targetBranch', 'sourceCommit', 'targetCommit', 'threads',
		'reviewedFiles', 'reviewedFileSnapshots', 'seqCounter', 'sourceFile',
	], {
		version: 2, sourceBranch: review.sourceBranch, targetBranch: review.targetBranch,
		sourceCommit: review.sourceCommit, targetCommit: review.targetCommit,
		threads: review.threads.map((thread, index) =>
			serializeThread(thread, originalItem(record(original) ? original.threads : undefined, thread.id, index))),
		...(review.reviewedFiles?.length ? { reviewedFiles: review.reviewedFiles } : {}),
		...(snapshots ? { reviewedFileSnapshots: snapshots } : {}),
		...(review.seqCounter !== undefined ? { seqCounter: review.seqCounter } : {}),
	});
}

export function humanAuthor(name: string): ReviewAuthor { return { kind: 'human', name }; }

export function addComment(review: Review, threadId: string, body: string, author: ReviewAuthor, tags: string[] = []): ReviewComment | undefined {
	const thread = review.threads.find((item) => item.id === threadId);
	if (!thread) { return undefined; }
	const comment: ReviewComment = {
		id: newId('c'), body, timestamp: new Date().toISOString(), author,
		...(tags.length ? { tags: [...tags] } : {}),
	};
	thread.comments.push(comment);
	return comment;
}

export function addReply(review: Review, threadId: string, replyToId: string | undefined, body: string, author: ReviewAuthor, tags: string[] = []): ReviewComment | undefined {
	const thread = review.threads.find((item) => item.id === threadId);
	if (!thread) { return undefined; }
	const comment = addComment(review, threadId, body, author, tags)!;
	comment.replyTo = replyToId ?? thread.comments[thread.comments.length - 2]?.id;
	return comment;
}

export function setThreadState(review: Review, threadId: string, state: 'resolved' | 'unresolved'): boolean {
	const thread = review.threads.find((item) => item.id === threadId);
	if (!thread) { return false; }
	thread.state = state;
	return true;
}

export function addThreadTags(review: Review, threadId: string, tags: string[]): boolean {
	const thread = review.threads.find((item) => item.id === threadId);
	if (!thread) { return false; }
	for (const tag of tags) { if (tag && !thread.tags.includes(tag)) { thread.tags.push(tag); } }
	return true;
}

export function addThread(review: Review, filePath: string | undefined, startLine: number | undefined, endLine: number | undefined,
	body: string, author: ReviewAuthor, tags: string[] = [], anchorText?: string): ReviewThread {
	if (review.seqCounter === undefined) { normalizeSeq(review); }
	const thread: ReviewThread = {
		id: newId('t'), filePath, startLine, endLine, state: 'unresolved',
		seq: review.seqCounter = (review.seqCounter ?? 0) + 1, tags: [...tags],
		...(anchorText !== undefined ? { anchorText } : {}), comments: [],
	};
	review.threads.push(thread);
	addComment(review, thread.id!, body, author, tags);
	return thread;
}

export function addGeneralThread(review: Review, body: string, author: ReviewAuthor, title?: string): ReviewThread {
	const thread = addThread(review, undefined, undefined, undefined, body, author);
	if (title?.trim()) { thread.title = title.trim(); }
	return thread;
}
