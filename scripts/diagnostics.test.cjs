const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const diagnostics = require('../out/diagnostics');

function begin(enabled = true) {
	const lines = [];
	diagnostics.startDiagnostics(diagnostics.now(), enabled, (line) => lines.push(line), { fixture: true });
	return lines;
}

function loadCompiled(name, mocks = {}) {
	const filename = path.resolve(__dirname, '..', 'out', `${name}.js`);
	const module = { exports: {} };
	const nativeRequire = createRequire(filename);
	vm.runInThisContext(wrap(fs.readFileSync(filename, 'utf8')), { filename })(
		module.exports, (id) => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id),
		module, filename, path.dirname(filename),
	);
	return module.exports;
}

test('nested and overlapping operations retain the correct parent and export inclusive summaries', async () => {
	begin();
	await diagnostics.trace('root', async () => {
		await Promise.all([
			diagnostics.trace('left', async () => {
				await Promise.resolve();
				diagnostics.event('left.event');
			}),
			diagnostics.trace('right', async () => {
				await Promise.resolve();
				diagnostics.event('right.event');
			}),
		]);
	});
	const snapshot = diagnostics.diagnosticsSnapshot();
	const start = (name) => snapshot.records.find((r) => r.name === name && r.kind === 'start');
	assert.equal(start('left').parentId, start('root').spanId);
	assert.equal(start('right').parentId, start('root').spanId);
	assert.equal(snapshot.records.find((r) => r.name === 'left.event').parentId, start('left').spanId);
	assert.equal(snapshot.records.find((r) => r.name === 'right.event').parentId, start('right').spanId);
	assert.equal(snapshot.aggregates.root.count, 1);
	assert.ok(snapshot.aggregates.root.totalMs >= 0);
	assert.equal(snapshot.pending.length, 0);
	assert.match(snapshot.durationSemantics, /overlapping/);
});

test('failed operations preserve errors, export codes without messages, and pending operations remain inspectable', async () => {
	const lines = begin();
	const failure = Object.assign(new Error('private path and review text'), { code: 128 });
	let release;
	const work = diagnostics.trace('blocked', () => new Promise((resolve) => { release = resolve; }));
	assert.equal(diagnostics.diagnosticsSnapshot().pending[0].name, 'blocked');
	await assert.rejects(diagnostics.trace('failure', async () => { throw failure; }), (error) => error === failure);
	assert.equal(diagnostics.diagnosticsSnapshot().aggregates.failure.errors, 1);
	assert.ok(lines.some((line) => line.includes('"code":128')));
	assert.ok(lines.every((line) => !line.includes(failure.message)));
	release();
	await work;
	assert.equal(diagnostics.diagnosticsSnapshot().pending.length, 0);
});

test('wall-clock jumps do not affect timers; milestones are first-only and records are bounded', () => {
	begin();
	const original = Date.now;
	const start = diagnostics.now();
	try {
		Date.now = () => -999999999;
		assert.ok(diagnostics.now() >= start);
		diagnostics.milestone('ready', { count: 0 });
		diagnostics.milestone('ready', { count: 99 });
		for (let i = 0; i < 10020; i++) { diagnostics.event('tick', { i }); }
	} finally {
		Date.now = original;
	}
	const snapshot = diagnostics.diagnosticsSnapshot();
	assert.equal(snapshot.records.length, 10000);
	assert.equal(snapshot.droppedRecords, 22);
	assert.equal(snapshot.records.at(-1).fields.i, 10019);
	assert.equal(snapshot.milestones.ready.fields.count, 0);
	assert.ok(snapshot.records.every((r, i, all) => !i || r.atMs >= all[i - 1].atMs));
});

test('disabled diagnostics do not record work and re-enabling marks a partial run', async () => {
	const lines = begin(false);
	assert.equal(await diagnostics.trace('disabled', async () => 42), 42);
	diagnostics.event('hidden');
	assert.equal(lines.length, 0);
	diagnostics.setDiagnosticsEnabled(true);
	assert.equal(diagnostics.diagnosticsSnapshot().records[0].fields.partialRun, true);
	diagnostics.setDiagnosticsEnabled(false);
	assert.equal(diagnostics.diagnosticsSnapshot().enabled, false);
	assert.equal(diagnostics.diagnosticsSnapshot().continuousCapture, false);
});

test('Base action traces cover early feedback and settled content without recording private refs', async () => {
	const lines = begin();
	const messages = [];
	let release;
	const wait = new Promise((resolve) => { release = resolve; });
	const active = { compareCommit: 'private-source-id', base: 'private-target' };
	const { ComparisonWebviewProvider } = loadCompiled('comparisonView', {
		vscode: {}, './gitApi': {}, './webviewMetrics': { PaneMetrics: class { bind() {} } },
	});
	const provider = new ComparisonWebviewProvider(() => active, async () => { await wait; }, () => {}, () => {});
	let receive;
	provider.postState = async () => { messages.push({ type: 'state' }); };
	provider.resolveWebviewView({ onDidDispose: () => ({ dispose() {} }), webview: {
		postMessage: (message) => { messages.push(message); return Promise.resolve(true); },
		onDidReceiveMessage: (handler) => { receive = handler; },
	} });
	messages.length = 0;
	const pin = provider.setCommitAsBase('b'.repeat(40));
	assert.equal(messages[0].type, 'baseActionStart');
	assert.ok(diagnostics.diagnosticsSnapshot().pending.some((span) => span.name === 'comparison.pinAction'));
	release();
	await pin;
	assert.deepEqual(messages.map((message) => message.type), ['baseActionStart', 'state', 'baseActionEnd']);
	const id = messages[0].id;
	for (const type of ['baseActionFeedback', 'baseActionSelector', 'baseActionContent']) {
		await receive({ type, id, ms: 1 });
	}
	const snapshot = diagnostics.diagnosticsSnapshot();
	const action = snapshot.records.find((record) => record.name === 'comparison.pinAction' && record.kind === 'end');
	assert.equal(action.outcome, 'ok');
	assert.equal(action.fields.cachedPreview, false);
	assert.ok(action.fields.actionId > 0);
	assert.ok(['comparison.baseFeedbackDom', 'comparison.baseSelectorDom', 'comparison.baseContentDom'].every((name) =>
		snapshot.records.some((record) => record.name === name && record.fields.actionId === id)));
	assert.ok(lines.every((line) => !line.includes(active.base) && !line.includes(active.compareCommit) && !line.includes('b'.repeat(40))));
	diagnostics.setDiagnosticsEnabled(false);
});

test('a failed Base action ends progress explicitly and is recorded as an error', async () => {
	begin();
	const messages = [];
	const { ComparisonWebviewProvider } = loadCompiled('comparisonView', {
		vscode: {}, './gitApi': {}, './webviewMetrics': { PaneMetrics: class {} },
	});
	const provider = new ComparisonWebviewProvider(() => ({ base: 'parent' }), () => {}, () => {}, () => {});
	provider.view = { webview: { postMessage: (message) => { messages.push(message); return Promise.resolve(true); } } };
	provider.postState = async () => {};
	await assert.rejects(provider.unpinBase(async () => { throw new Error('private failure'); }), /private failure/);
	assert.equal(messages.at(-1).type, 'baseActionEnd');
	assert.equal(messages.at(-1).ok, false);
	assert.equal(diagnostics.diagnosticsSnapshot().aggregates['comparison.unpinAction'].errors, 1);
	diagnostics.setDiagnosticsEnabled(false);
});
test('pending retention is bounded and disabling logging while a span runs still clears it', async () => {
	begin();
	let release;
	const blocked = new Promise((resolve) => { release = resolve; });
	const operations = Array.from({ length: 1030 }, () => diagnostics.trace('blocked', () => blocked));
	const snapshot = diagnostics.diagnosticsSnapshot();
	assert.equal(snapshot.pending.length, 1024);
	assert.equal(snapshot.droppedPendingSpans, 6);
	diagnostics.setDiagnosticsEnabled(false);
	release();
	await Promise.all(operations);
	assert.equal(diagnostics.diagnosticsSnapshot().pending.length, 0);
});

test('read-only Git spans use execFile without exporting paths, refs or subprocess output', async () => {
	const lines = begin();
	const calls = [];
	const executor = (shell) => {
		const fn = () => {};
		fn[require('node:util').promisify.custom] = async (...args) => {
			calls.push({ shell, args });
			if (args[1]?.[0] === 'rev-parse' && args[1].includes('--show-toplevel')) {
				throw Object.assign(new Error('private-error-output'), { code: 128 });
			}
			return { stdout: 'private-command-output', stderr: 'private-stderr' };
		};
		return fn;
	};
	const git = loadCompiled('git', {
		child_process: { exec: executor(true), execFile: executor(false) },
	});
	assert.equal(await git.getCurrentBranch('private-workspace-path'), 'private-command-output');
	assert.equal(await git.runGitQuery('private-workspace-path', ['show', 'private-ref:private-file']), 'private-command-output');
	assert.equal(await git.getRepoRoot('private-workspace-path'), undefined);
	assert.equal(calls.length, 3);
	assert.ok(calls.every((call) => !call.shell));
	assert.equal(diagnostics.diagnosticsSnapshot().aggregates['git.command'].count, 3);
	assert.equal(diagnostics.diagnosticsSnapshot().aggregates['git.command'].errors, 1);
	assert.ok(lines.every((line) => !line.includes('private-')));
});

test('review diagnostics distinguish loaded, invalid, missing and inaccessible files without recording content', async () => {
	const lines = begin();
	const uri = (fsPath) => ({ fsPath, toString: () => fsPath });
	const root = path.resolve('private-root');
	const vscode = {
		FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
		Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
		workspace: {
			workspaceFolders: [{ uri: uri(root) }],
			findFiles: async () => assert.fail('Do not search the workspace'),
			fs: {
				readDirectory: async (uri) => path.basename(uri.fsPath) === 'lighthouse-reviews'
					? ['valid', 'invalid', 'missing', 'denied'].map((name) => [name, 2])
					: [['comments.json', 1]],
				readFile: async (uri) => {
				const name = path.basename(path.dirname(uri.fsPath));
				if (name === 'missing' || name === 'denied') {
					throw Object.assign(new Error('private-file-error'), { code: name === 'missing' ? 'FileNotFound' : 'EACCES' });
				}
				return Buffer.from(name === 'valid' ? '{"threads":[],"sourceBranch":"private-branch"}' : 'private-invalid-json');
			} },
		},
	};
	const store = loadCompiled('reviewStore', { vscode });
	const reviews = await store.scanReviews();
	assert.equal(reviews.length, 1);
	assert.equal(reviews[0].sourceBranch, 'private-branch');
	const snapshot = diagnostics.diagnosticsSnapshot();
	assert.deepEqual(snapshot.records.filter((r) => r.name === 'reviews.loadResult').map((r) => r.fields.outcome).sort(),
		['loaded', 'invalidParse', 'missing', 'error'].sort());
	assert.equal(snapshot.aggregates['reviews.discover'].count, 1);
	assert.equal(snapshot.aggregates['reviews.read'].count, 4);
	assert.equal(snapshot.aggregates['reviews.parse'].count, 2);
	assert.ok(lines.every((line) => !line.includes('private-')));
});

test('Git API activation is shared while pending and unavailable results preserve CLI fallback', async () => {
	begin();
	let release;
	let activations = 0;
	const exports = new Promise((resolve) => { release = resolve; });
	const extension = { isActive: false, activate: () => { activations++; return exports; } };
	const vscode = {
		extensions: { getExtension: () => extension },
		Uri: { file: (fsPath) => ({ fsPath }) },
	};
	let cliCalls = 0;
	const gitApi = loadCompiled('gitApi', { vscode, './git': {
		listBranchesCli: async () => { cliCalls++; return []; },
	} });
	const first = gitApi.getGitApi();
	const second = gitApi.getGitApi();
	assert.equal(first, second);
	assert.equal(activations, 1);
	assert.ok(diagnostics.diagnosticsSnapshot().pending.some((span) => span.name === 'gitApi.activate'));
	release({ getAPI: () => undefined });
	assert.equal(await first, undefined);
	assert.equal(await second, undefined);
	assert.deepEqual(await gitApi.listBranches('private-workspace'), []);
	assert.equal(cliCalls, 1);
	assert.equal(activations, 2);
	assert.ok(diagnostics.diagnosticsSnapshot().records.some((r) =>
		r.name === 'gitApi.decision' && r.fields.source === 'cli' && r.fields.reason === 'apiUnavailable'));
});

function emitter() {
	const handlers = new Set();
	return {
		event: (handler) => { handlers.add(handler); return { dispose: () => handlers.delete(handler) }; },
		fire: (value) => { for (const handler of handlers) { handler(value); } },
	};
}

function paneFixture(name = 'files') {
	begin();
	const metrics = loadCompiled('webviewMetrics', { vscode: {}, './perf': { perfCount() {} } });
	const messages = emitter(), visibility = emitter(), dispose = emitter();
	const sent = [];
	const view = {
		visible: true,
		webview: { onDidReceiveMessage: messages.event, postMessage: async (message) => { sent.push(message); return true; } },
		onDidChangeVisibility: visibility.event, onDidDispose: dispose.event,
	};
	const pane = new metrics.PaneMetrics(name);
	pane.bind(view);
	const reply = (requestId, type = 'rendered', count = 0) => messages.fire({ type, view: name, requestId, count, ms: 2 });
	return { metrics, pane, view, messages, visibility, dispose, sent, reply };
}

test('placeholder DOM is not content readiness; legitimate empty content is ready and paint opportunity is separate', async () => {
	const f = paneFixture();
	f.pane.post({ type: 'state', tree: null });
	f.reply(1);
	assert.ok(diagnostics.diagnosticsSnapshot().milestones['files.firstDom']);
	assert.equal(diagnostics.diagnosticsSnapshot().milestones['files.contentReady'], undefined);
	f.metrics.setComparisonSettled();
	f.pane.post({ type: 'state', tree: null });
	f.reply(2);
	assert.equal(diagnostics.diagnosticsSnapshot().milestones['files.contentReady'].fields.state, 'empty');
	assert.equal(diagnostics.diagnosticsSnapshot().milestones['files.contentPaintOpportunity'], undefined);
	f.reply(2, 'paintOpportunity');
	assert.ok(diagnostics.diagnosticsSnapshot().milestones['files.contentPaintOpportunity']);
	assert.equal(f.metrics.paneSnapshot().allCurrentlyVisiblePanesReady, true);
	await Promise.resolve();
});

test('errors are distinct from empty results and superseded or hidden renders do not claim visible readiness', () => {
	const f = paneFixture('comparison');
	f.pane.post({ type: 'state', ready: true });
	f.pane.post({ type: 'state', baselineError: 'private branch name' });
	f.reply(1, 'rendered', 3);
	assert.equal(diagnostics.diagnosticsSnapshot().milestones['comparison.contentReady'], undefined);
	f.view.visible = false;
	f.visibility.fire();
	f.reply(2);
	assert.equal(diagnostics.diagnosticsSnapshot().milestones['comparison.contentReady'], undefined);
	assert.equal(f.metrics.paneSnapshot().allCurrentlyVisiblePanesReady, null);
	f.view.visible = true;
	f.visibility.fire();
	f.reply(2);
	assert.equal(diagnostics.diagnosticsSnapshot().milestones['comparison.contentReady'].fields.state, 'error');
	assert.ok(!JSON.stringify(diagnostics.diagnosticsSnapshot()).includes('private branch name'));
	f.dispose.fire();
	assert.equal(f.pane.snapshot().resolved, false);
});

test('transport size is UTF-8 bytes and invalid acknowledgements cannot complete a pane', () => {
	const f = paneFixture();
	f.pane.post({ type: 'state', tree: { name: '\u00e9' } });
	const serialized = diagnostics.diagnosticsSnapshot().records.find((r) => r.name === 'files.serialize');
	assert.equal(serialized.fields.bytes, Buffer.byteLength(JSON.stringify(f.sent[0]), 'utf8'));
	for (const ms of [NaN, Infinity, -1]) {
		f.messages.fire({ type: 'rendered', view: 'files', requestId: 1, ms, count: 1 });
	}
	f.messages.fire({ type: 'rendered', view: 'wrong-pane', requestId: 1, ms: 1, count: 1 });
	assert.equal(diagnostics.diagnosticsSnapshot().milestones['files.contentReady'], undefined);
	assert.equal(f.pane.snapshot().pending.length, 1);
});

test('pane generations discard old deliveries and bound unacknowledged messages', () => {
	const f = paneFixture();
	for (let i = 0; i < 70; i++) { f.pane.post({ type: 'state', tree: [] }); }
	assert.equal(f.pane.snapshot().pending.length, 64);
	f.pane.bind(f.view);
	f.reply(70);
	assert.equal(f.pane.snapshot().pending.length, 0);
	assert.equal(diagnostics.diagnosticsSnapshot().milestones['files.contentReady'], undefined);
});

test('revealing a retained pane records existing DOM readiness without requesting another render', () => {
	const f = paneFixture();
	f.view.visible = false;
	f.pane.post({ type: 'state', tree: [] });
	f.reply(1);
	f.reply(1, 'paintOpportunity');
	assert.equal(diagnostics.diagnosticsSnapshot().milestones['files.contentReady'], undefined);
	f.view.visible = true;
	f.visibility.fire();
	const ready = diagnostics.diagnosticsSnapshot().milestones['files.contentReady'];
	assert.equal(ready.fields.retained, true);
	assert.equal(ready.fields.state, 'empty');
	assert.equal(f.sent.length, 1);
});

test('disabled pane logging sends the original payload and does not report stale readiness', () => {
	const f = paneFixture();
	f.pane.post({ type: 'state', tree: [] });
	f.reply(1);
	diagnostics.setDiagnosticsEnabled(false);
	const payload = { type: 'state', tree: null };
	f.pane.post(payload);
	assert.deepEqual(f.sent.at(-1), payload);
	assert.equal(f.pane.snapshot().contentReady, false);
	assert.equal(f.metrics.paneSnapshot().allCurrentlyVisiblePanesReady, null);
});

test('webview script separates synchronous DOM time from two-frame opportunity and ignores superseded frames', () => {
	const { renderMetricsScript } = loadCompiled('webviewShell', { vscode: {} });
	const messages = [], handlers = [], frames = [];
	const client = {
		window: { addEventListener: (_, fn) => handlers.push(fn) },
		vscode: { postMessage: (msg) => messages.push(msg) },
		performance: { now: () => 10 },
		requestAnimationFrame: (fn) => frames.push(fn),
	};
	vm.runInNewContext(renderMetricsScript(), client);
	handlers[0]({ data: { type: 'state', diagnostic: { requestId: 1 } } });
	client.reportRendered('files', 4, 5);
	assert.equal(messages[0].type, 'rendered');
	assert.equal(messages[0].ms, 5);
	assert.equal(messages.length, 1);
	frames.shift()();
	frames.shift()();
	assert.equal(messages[1].type, 'paintOpportunity');
	client.reportRendered('files', 4, 5);
	handlers[0]({ data: { type: 'state', diagnostic: { requestId: 2 } } });
	frames.shift()();
	frames.shift()();
	assert.equal(messages.length, 3);
});

test('lazy startup stays Git-free before demand, retries cleanly, shares snapshots and retains ref races', async () => {
	const commands = new Map();
	const panes = new Map();
	const noop = () => {};
	const disposable = () => ({ dispose: noop });
	const configuration = { get: (_key, fallback) => fallback };
	const channel = { appendLine: noop, dispose: noop };
	const watches = [];
	const failures = [];
	const watcher = (pattern) => {
		const change = emitter();
		const item = { onDidCreate: disposable, onDidChange: change.event, onDidDelete: disposable,
			dispose: () => { item.disposed = true; }, disposed: false, change, pattern };
		watches.push(item);
		return item;
	};
	let exported;
	let editorPath = '/private-file.ts', editorColumn = 1, tabsChanged;
	const vscode = {
		version: 'fixture',
		Uri: { file: (fsPath) => ({ fsPath }), joinPath: (base, leaf) => ({ fsPath: `${base.fsPath}\\${leaf}` }) },
		RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
		workspace: {
			isTrusted: true, workspaceFolders: [{ uri: { fsPath: 'fixture-workspace' } }],
			getConfiguration: () => configuration, onDidChangeConfiguration: disposable,
			registerTextDocumentContentProvider: disposable, createFileSystemWatcher: watcher,
			fs: { writeFile: async (_uri, bytes) => { exported = JSON.parse(bytes.toString()); } },
		},
		window: {
			state: { focused: true },
			tabGroups: {
				get activeTabGroup() {
					return { viewColumn: editorColumn, activeTab: { input: {
						original: { scheme: 'git', path: editorPath, query: '~' },
						modified: { scheme: 'file', path: editorPath, query: '' },
					} } };
				},
				onDidChangeTabs: (handler) => { tabsChanged = handler; return disposable(); },
				onDidChangeTabGroups: disposable,
			},
			onDidChangeWindowState: disposable,
			createOutputChannel: (name) => { assert.equal(name, 'Lighthouse'); return channel; },
			registerWebviewViewProvider: (id, provider) => { panes.set(id, provider); return disposable(); },
			registerWebviewPanelSerializer: disposable,
			onDidChangeActiveTextEditor: disposable,
			showSaveDialog: async (options) => {
				assert.match(options.defaultUri.fsPath, /lighthouse-startup\.json$/);
				return { fsPath: 'fixture-export' };
			},
			showInformationMessage: noop, showErrorMessage: (message) => failures.push(message),
		},
		commands: { registerCommand: (name, handler) => { commands.set(name, handler); return disposable(); } },
	};
	const perf = loadCompiled('perf', { vscode });
	const metrics = loadCompiled('webviewMetrics', { vscode });
	let comparisonRefreshes = 0, fileRefreshes = 0, invalidations = 0;
	let waitForRepository, releaseDefaults;
	const defaultsReady = new Promise((resolve) => { releaseDefaults = resolve; });
	class Provider { refresh() {} revealForUri() {} resolveWebviewView() {} invalidateBranches() { invalidations++; } }
	class ComparisonProvider extends Provider {
		constructor(...args) { super(); waitForRepository = args[4]; }
		refresh() { comparisonRefreshes++; }
	}
	class FilesProvider extends Provider { refresh() { fileRefreshes++; } }
	let commentRenders = 0, rootQueries = 0, replyCalls = 0, conversationOpens = 0;
	let repoChanged, refsChanged, resolveCalls = 0, snapshotCalls = 0, raceDuringResolve = true;
	let failDefaultsOnce = true;
	const snapshots = [];
	class Comments { render() { commentRenders++; } dispose() {} handleReply() { replyCalls++; } }
	class StatusBar { update() {} dispose() {} }
	class Comparison {
		async computeDefaults(snapshot) {
			assert.equal(watches.filter((watch) => !watch.disposed).length, 3, 'HEAD/shared-ref watches must precede metadata capture');
			await defaultsReady;
			if (failDefaultsOnce) {
				failDefaultsOnce = false;
				throw new Error('transient initialization failure');
			}
			this.headCommit = 'known';
			snapshots.push(snapshot);
			refsChanged('opened');
			repoChanged('opened');
		}
		async resolve(snapshot) {
			resolveCalls++;
			snapshots.push(snapshot);
			this.baselineCommit = 'resolved';
			if (raceDuringResolve) {
				raceDuringResolve = false;
				watches.findLast((watch) => watch.pattern?.pattern === '{HEAD,config.worktree}').change.fire();
			}
		}
	}
	let release;
	const root = new Promise((resolve) => { release = resolve; });
	const extension = loadCompiled('extension', {
		vscode, './perf': perf, './webviewMetrics': metrics,
		'./commentController': { LighthouseCommentController: Comments },
		'./tagCompletion': { registerTagCompletion: disposable },
		'./reviewStore': {}, './reviewModel': {},
		'./reviewedFiles': loadCompiled('reviewedFiles', { vscode, './reviewStore': {}, './git': {} }),
		'./statusBar': { ReviewStatusBar: StatusBar },
		'./gitApi': {
			getGitApi: async () => undefined,
			onRepoStateChanged: async (_cwd, handler, refHandler) => {
				repoChanged = handler;
				refsChanged = refHandler;
				return undefined;
			},
			getHead: async () => ({ branch: 'feature', commit: 'known', detached: false }),
		},
		'./git': {
			getRepositoryInfo: () => { rootQueries++; return root; },
			readComparisonRefs: async () => { snapshotCalls++; return 'captured refs'; },
		},
		'./activeComparison': { ActiveComparison: Comparison },
		'./comparisonView': { ComparisonWebviewProvider: ComparisonProvider },
		'./filesWebview': { FilesWebviewProvider: FilesProvider, syncUncommittedContext: noop, isUncommittedHidden: () => false },
		'./commitsWebview': { CommitsWebviewProvider: Provider },
		'./conversationsWebview': { ConversationsWebviewProvider: Provider, syncResolvedContext: noop, isResolvedHidden: () => false },
		'./reviewDiff': { DIFF_SCHEME: 'fixture', ReviewDiffContentProvider: class {} },
		'./conversationDocument': {
			CONVERSATION_SCHEME: 'lighthouse-conversation',
			ConversationDocumentProvider: class { open() { conversationOpens++; } refresh() {} dispose() {} },
		},
		'./conversationPage': {
			CONVERSATION_PAGE_TYPE: 'lighthouse.conversationPage',
			ConversationPages: class { open() { conversationOpens++; } openNew() {} refresh() {} dispose() {} },
		},
	});
	const context = {
		subscriptions: [], extension: { packageJSON: { version: 'fixture' } },
		workspaceState: { get: (_key, fallback) => fallback }, logUri: { fsPath: 'fixture-logs' },
	};
	try {
		await extension.activate(context);
		for (const { command } of require('../package.json').contributes.commands) {
			assert.ok(commands.has(command), `Manifest command must have a runtime handler: ${command}`);
		}
		assert.deepEqual([...panes.keys()], require('../package.json').contributes.views.lighthouse.map((view) => view.id));
		assert.ok(require('../package.json').contributes.commands.some(
			(command) => command.command === 'lighthouse.exportStartupDiagnostics'));
		assert.ok(diagnostics.diagnosticsSnapshot().milestones['activation.return']);
		assert.equal(diagnostics.diagnosticsSnapshot().milestones['startup.backgroundComplete'], undefined);
		assert.equal(rootQueries, 0);
		assert.equal(commentRenders, 1);
		assert.ok(require('../package.json').activationEvents.includes('onStartupFinished'));
		await commands.get('lighthouse.createOrReply')({});
		assert.equal(replyCalls, 1);
		assert.equal(rootQueries, 0);
		await commands.get('lighthouse.viewConversation')({});
		assert.equal(conversationOpens, 1);
		assert.equal(rootQueries, 0);
		await commands.get('lighthouse.exportStartupDiagnostics')();
		assert.equal(rootQueries, 0);
		assert.ok(exported.usage);
		for (let i = 0; i < 20; i++) { tabsChanged(); }
		await commands.get('lighthouse.exportStartupDiagnostics')();
		assert.equal(exported.usage.counts.internal.editorChanged, 0);
		editorPath = '/another-private-file.ts';
		tabsChanged();
		editorColumn = 2;
		tabsChanged();
		await commands.get('lighthouse.exportStartupDiagnostics')();
		assert.equal(exported.usage.counts.internal.editorChanged, 2);
		assert.ok(!JSON.stringify(exported.usage).includes('private-file'));
		const firstPane = panes.get('lighthouse.comparison').resolveWebviewView({}, {}, {});
		const secondPane = panes.get('lighthouse.files').resolveWebviewView({}, {}, {});
		await new Promise(setImmediate);
		assert.equal(rootQueries, 1);
		assert.ok(diagnostics.diagnosticsSnapshot().pending.some((span) => span.name === 'startup.repoRoot'));
		await commands.get('lighthouse.exportStartupDiagnostics')();
		assert.equal(exported.trace.schemaVersion, 1);
		assert.ok(exported.trace.pending.some((span) => span.name === 'startup.repoRoot'));
		release({ root: 'fixture-workspace', headPath: path.resolve('.git', 'HEAD'), commonDir: path.resolve('.git') });
		const rootReady = await Promise.race([
			waitForRepository().then(() => true),
			new Promise((resolve) => { const timer = setTimeout(() => resolve(false), 1000); timer.unref(); }),
		]);
		assert.equal(rootReady, true, 'Comparison branch choices must not wait for default-target discovery');
		assert.equal(diagnostics.diagnosticsSnapshot().milestones['startup.comparisonResolved'], undefined);
		assert.ok(diagnostics.diagnosticsSnapshot().milestones['startup.repositoryReady']);
		releaseDefaults();
		const failed = await Promise.allSettled([firstPane, secondPane]);
		assert.ok(failed.every((result) => result.status === 'rejected' && /transient/.test(result.reason.message)));
		assert.equal(failures.length, 1);
		assert.ok(watches[1].disposed && watches[2].disposed, 'failed initialization disposes its early watches');
		await Promise.all([
			panes.get('lighthouse.comparison').resolveWebviewView({}, {}, {}),
			panes.get('lighthouse.files').resolveWebviewView({}, {}, {}),
		]);
		await new Promise(setImmediate);
		assert.ok(diagnostics.diagnosticsSnapshot().milestones['startup.backgroundComplete']);
		assert.ok(diagnostics.diagnosticsSnapshot().milestones['startup.comparisonResolved']);
		assert.equal(diagnostics.diagnosticsSnapshot().pending.length, 0);
		assert.equal(rootQueries, 2);
		assert.equal(snapshotCalls, 2);
		assert.equal(watches[1].pattern.pattern, '{HEAD,config.worktree}');
		assert.equal(watches[2].pattern.pattern, '{refs/**,packed-refs,config}');
		assert.equal(resolveCalls, 1);
		assert.equal(snapshots[0], snapshots[1], 'defaults and resolution share one watched snapshot');
		assert.equal(snapshots[0].refs, 'captured refs');
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(resolveCalls, 2, 'a ref change during startup must receive a fresh trailing resolution');
		assert.equal(snapshots[2], undefined, 'a startup race cannot reuse the older captured refs');
		assert.ok(diagnostics.diagnosticsSnapshot().records.some((record) =>
			record.name === 'refs.refreshRequested' && record.fields.reason === 'startup-raced'));
		const comparisonBefore = comparisonRefreshes, filesBefore = fileRefreshes;
		repoChanged('working-tree');
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(resolveCalls, 2);
		assert.equal(comparisonRefreshes, comparisonBefore);
		assert.equal(fileRefreshes, filesBefore + 1);
		raceDuringResolve = true;
		repoChanged('head-or-refs');
		await new Promise((resolve) => setTimeout(resolve, 650));
		assert.equal(resolveCalls, 4, 'a ref event during resolution retains a trailing fresh pass');
		assert.equal(invalidations, 4, 'each initialization invalidates unwatched cached data; only actual ref events add more');
	} finally {
		releaseDefaults();
		release({ root: 'fixture-workspace', headPath: path.resolve('.git', 'HEAD'), commonDir: path.resolve('.git') });
		for (const subscription of context.subscriptions) { subscription.dispose(); }
	}
});
