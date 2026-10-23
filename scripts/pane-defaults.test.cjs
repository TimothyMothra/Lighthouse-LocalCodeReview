const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const manifest = require('../package.json');

function loadCompiled(name, mocks) {
	const filename = path.resolve(__dirname, '..', 'out', `${name}.js`);
	const module = { exports: {} };
	const nativeRequire = createRequire(filename);
	vm.runInThisContext(wrap(fs.readFileSync(filename, 'utf8')), { filename })(
		module.exports, (id) => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id),
		module, filename, path.dirname(filename),
	);
	return module.exports;
}

function fixture(name, mocks = {}) {
	const states = [], commands = [], values = new Map();
	const memento = {
		get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
		update: async (key, value) => values.set(key, value),
	};
	const exports = loadCompiled(name, {
		vscode: { commands: { executeCommand: async (...args) => commands.push(args) } },
		'./reviewStore': {}, './reviewDiff': { DIFF_SCHEME: 'lighthouse-diff' },
		'./webviewMetrics': {
			PaneMetrics: class { post(state) { states.push(state); } build(work) { return work(); } },
			logBuild() {},
		},
		...mocks,
	});
	return { exports, states, commands, memento, values };
}

function client(html) {
	let receive;
	const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
	const context = vm.createContext({
		document: { getElementById: () => ({}) },
		window: { addEventListener: (_, handler) => { receive = handler; } },
		vscode: { postMessage() {} },
		performance: { now: () => 0 }, reportRendered() {},
	});
	vm.runInContext(scripts.at(-1)[1], context);
	vm.runInContext('paint = () => {};', context);
	return {
		send: (data) => receive({ data }),
		run: (source) => vm.runInContext(source, context),
		state: (expression) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)),
	};
}

test('panes put collapsed combined Comparison above Files and Conversations', () => {
	const views = manifest.contributes.views.lighthouse;
	assert.deepEqual(views.map((view) => view.id), [
		'lighthouse.comparison', 'lighthouse.files', 'lighthouse.conversations',
	]);
	assert.equal(views[0].visibility, 'collapsed');
	assert.ok(views.slice(1).every((view) => !view.visibility || view.visibility === 'visible'));
	const buttons = manifest.contributes.menus['view/title'];
	// Keep setup discoverable at the top view without adding another icon-only toolbar control.
	const setup = buttons.find((button) => button.command === 'lighthouse.configureCopilotMcp');
	assert.equal(setup?.when, `view == ${views[0].id}`);
	assert.ok(setup.group && !setup.group.startsWith('navigation'));
	assert.ok(!buttons.some((button) => button.command === 'lighthouse.commitsViewAllChanges' && button.when.includes('lighthouse.files')));
	// Only the unused button is removed; the command remains available from the command palette.
	assert.ok(manifest.contributes.commands.some((command) => command.command === 'lighthouse.commitsViewAllChanges'));
});

test('Commits and Changed Files use downward artwork rotated right only when collapsed', () => {
	const commits = require('../out/commitsWebview');
	const f = fixture('filesWebview');
	const provider = new f.exports.FilesWebviewProvider(() => undefined, {}, () => {}, f.memento);
	const files = provider.html({ cspSource: 'fixture' });
	for (const source of [commits.COMMITS_JS, files]) {
		assert.match(source, /const CHEVRON_SVG = '<svg[^']+d="M4 6l4 4 4-4H4z"/);
	}
	assert.match(commits.COMMITS_CSS, /\.commit\.collapsed\s*>\s*\.commit-row\s+\.commit-twisty\s*\{\s*transform:\s*rotate\(-90deg\)/);
	assert.match(files, /\.dir\.collapsed\s*>\s*\.row\s+\.twisty\s*\{\s*transform:\s*rotate\(-90deg\)/);
	assert.match(files, /\.glyph svg,\s*\.twisty svg\s*\{[^}]*fill:\s*currentColor/);
	assert.match(files, /\.twisty\s*\{[^}]*color:\s*var\(--vscode-icon-foreground\)/);
});

test('Files and Threads share full-sweep refresh feedback even when their contents are empty', () => {
	for (const [name, type] of [['filesWebview', 'FilesWebviewProvider'], ['conversationsWebview', 'ConversationsWebviewProvider']]) {
		const f = fixture(name);
		const provider = name === 'filesWebview'
			? new f.exports[type](() => undefined, {}, () => {}, f.memento)
			: new f.exports[type](() => undefined, f.memento);
		const html = provider.html({ cspSource: 'fixture' });
		const handlers = {}, listeners = [], progress = {
			hidden: true, addEventListener: (type, handler) => { handlers[type] = handler; },
		};
		const context = vm.createContext({
			document: { getElementById: (id) => { assert.equal(id, 'refresh-progress'); return progress; } },
			window: { addEventListener: (_, handler) => listeners.push(handler) },
			acquireVsCodeApi: () => ({ postMessage() {} }),
		});
		vm.runInContext([...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1], context);
		for (const running of [true, false]) {
			for (const handler of listeners) { handler({ data: { type: 'refreshProgress', id: 1, running } }); }
			assert.equal(progress.hidden, false);
		}
		handlers.animationiteration({ animationName: 'commit-progress-slide' });
		assert.equal(progress.hidden, true);
	}
});

test('Files sends an expanded initial tree, while explicit expansion commands remain authoritative', async () => {
	const f = fixture('filesWebview');
	const provider = new f.exports.FilesWebviewProvider(() => undefined, {}, () => {}, f.memento);
	provider.view = { webview: { postMessage: (state) => f.states.push(state) } };
	await provider.postState();
	assert.equal(f.states.at(-1).expanded, true);
	provider.setExpanded(false);
	await provider.postState();
	assert.equal(f.states.at(-1).expanded, false);
});

test('explicit Files refresh waits for split-view data and surfaces working-tree read failures', async () => {
	let release, failUncommitted = false;
	const f = fixture('filesWebview', {
		vscode: { workspace: { getConfiguration: () => ({ get: () => false }) } },
		'./git': { changedFilesUncommitted: async () => {
			if (failUncommitted) { throw new Error('Working-tree read failed'); }
			return { staged: [], unstaged: [], untracked: [] };
		} },
	});
	const active = {
		base: 'main', compare: 'feature', baselineCommit: 'baseline', comparisonKey: 'comparison',
		review: { reviewedFiles: [] },
		getChangedFiles: () => new Promise((resolve) => { release = resolve; }),
	};
	const provider = new f.exports.FilesWebviewProvider(() => active, {}, () => {}, f.memento);
	provider.view = {};
	let settled = false;
	const pending = provider.refresh(true).then(() => { settled = true; });
	await new Promise(setImmediate);
	assert.equal(settled, false);
	release([{ relPath: 'saved.ts', status: 'M' }]);
	await pending;
	assert.equal(f.states.at(-1).tree.files[0].name, 'saved.ts');
	assert.equal(f.states.at(-1).loading, undefined);
	failUncommitted = true;
	await assert.rejects(provider.refresh(true), /Working-tree read failed/);
});

test('Files expands initially without reopening manually collapsed folders on every refresh', () => {
	const f = fixture('filesWebview');
	const provider = new f.exports.FilesWebviewProvider(() => undefined, {}, () => {}, f.memento);
	const ui = client(provider.html({ cspSource: 'fixture' }));
	const tree = { dirs: [
		{ relPath: 'a', files: [], dirs: [{ relPath: 'a/nested', files: [], dirs: [] }] },
		{ relPath: 'b', files: [], dirs: [] },
	], files: [] };
	ui.send({ type: 'state', tree: null, expanded: true });
	ui.send({ type: 'state', tree, expanded: true });
	assert.equal(ui.state('expandAll'), true);
	ui.run("materializeExpansion(); expanded.delete('a');");
	ui.send({ type: 'state', tree, expanded: true });
	assert.equal(ui.state('expandAll'), false);
	assert.deepEqual(ui.state('[...expanded]'), ['a/nested', 'b']);
	ui.send({ type: 'setExpanded', value: true });
	assert.equal(ui.state('expandAll'), true);
	ui.send({ type: 'setExpanded', value: false });
	assert.deepEqual(ui.state('[...expanded]'), []);
});

test('Conversations hides resolved threads by default and preserves an explicit saved Show choice', async () => {
	const f = fixture('conversationsWebview');
	assert.equal(f.exports.isResolvedHidden(f.memento), true);
	await f.exports.syncResolvedContext(f.memento);
	assert.deepEqual(f.commands.at(-1), ['setContext', 'lighthouse.conversationsResolvedHidden', true]);
	const provider = new f.exports.ConversationsWebviewProvider(() => undefined, f.memento);
	const ui = client(provider.html({ cspSource: 'fixture' }));
	assert.equal(ui.state('hideResolved'), true);
	await provider.setHideResolved(false);
	assert.equal(f.exports.isResolvedHidden(f.memento), false);
	assert.deepEqual(f.commands.at(-1), ['setContext', 'lighthouse.conversationsResolvedHidden', false]);
	ui.send({ type: 'state', threads: [], hideResolved: false });
	assert.equal(ui.state('hideResolved'), false);
});
