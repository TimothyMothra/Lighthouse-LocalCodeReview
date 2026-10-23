/**
 * Lighthouse: Local Code Review — extension entry point.
 *
 * Wires together:
 *   - the "Local Reviews" TreeView (from the v0 scaffold),
 *   - the native `vscode.comments` CommentController (inline threads, reply/resolve, /tag),
 *   - `/tag` autocomplete on the comment input,
 *   - copy commands (commit id / branch / review dir),
 *   - "Ask Copilot to Review" commands that shell out to the `copilot` CLI (never a model directly),
 *   - a FileSystemWatcher that refreshes BOTH the tree and the CommentController on disk change.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { LighthouseCommentController } from './commentController';
import { registerTagCompletion } from './tagCompletion';
import * as store from './reviewStore';
import { Review } from './reviewModel';
import { ReviewStatusBar } from './statusBar';
import * as gitApi from './gitApi';
import {
	BranchRef,
	getRepoRoot,
	getRepositoryInfo,
	readComparisonRefs,
	fetch as gitFetch,
	aheadBehind,
	fastForward,
	fastForwardRef,
	runGitQuery,
} from './git';
import { ActiveComparison, ComparisonSnapshot } from './activeComparison';
import { ComparisonWebviewProvider } from './comparisonView';
import { FilesWebviewProvider, isUncommittedHidden, syncUncommittedContext } from './filesWebview';
import { ConversationsWebviewProvider, isResolvedHidden, syncResolvedContext } from './conversationsWebview';
import {
	DIFF_SCHEME,
	ReviewDiffContentProvider,
	openFileDiff,
	openAllChangesDiff,
	openCommitDiff,
	openCommitFileDiff,
	openUncommittedFileDiff,
	openCumulativeFileDiff,
	UncommittedGroup,
} from './reviewDiff';
import { initPerf, perf, perfLine } from './perf';
import { diagnosticsEnabled, diagnosticsRunId, diagnosticsSnapshot, event, milestone, now, setDiagnosticsEnabled, trace } from './diagnostics';
import { setComparisonSettled, paneSnapshot, resetPaneMetrics } from './webviewMetrics';
import { initUsage, setUsageEnabled, recordUsage, usageEditor, usageFocus, usageSnapshot, emitUsageSummary } from './usage';
import { classifyEditorInput, editorInputIdentity } from './usageContext';
import { ConversationDocumentProvider, CONVERSATION_SCHEME } from './conversationDocument';
import { ConversationPages, CONVERSATION_PAGE_TYPE } from './conversationPage';
import { ReviewedFiles } from './reviewedFiles';
import { mcpStorageDirectory } from './mcpIdentity';

/** Shared "Lighthouse" output channel for user-visible git/action feedback. Assigned in `activate`. */
let outputChannel: vscode.OutputChannel | undefined;

/** Timestamped line into the Lighthouse output channel (no-op before activation). */
function log(message: string): void {
	const stamp = new Date().toLocaleTimeString();
	outputChannel?.appendLine(`[${stamp}] ${message}`);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const tActivate = now();
	// Shared output channel for git/action feedback (Update, terminal, etc.).
	outputChannel = vscode.window.createOutputChannel('Lighthouse');
	context.subscriptions.push(outputChannel);
	const cfg = vscode.workspace.getConfiguration('lighthouse');
	initPerf(outputChannel, tActivate, {
		extensionVersion: context.extension.packageJSON.version,
		vscodeVersion: vscode.version, nodeVersion: process.version,
		platform: process.platform, arch: process.arch,
		workspaceFolders: vscode.workspace.workspaceFolders?.length ?? 0,
		autoCreateOnEmpty: cfg.get<boolean>('autoCreateOnEmpty', true),
		deferThreadsOnLoad: cfg.get<boolean>('deferThreadsOnLoad', true),
		cumulativeDiff: cfg.get<boolean>('files.cumulativeDiff', true),
		compactFolders: cfg.get<boolean>('files.compactFolders', true),
		autoReveal: cfg.get<boolean>('files.autoReveal', true),
		hideUncommitted: isUncommittedHidden(context.workspaceState),
		hideResolved: isResolvedHidden(context.workspaceState),
		extensionMode: context.extensionMode,
		trusted: vscode.workspace.isTrusted,
	});
	resetPaneMetrics();
	initUsage({
		runId: diagnosticsRunId(),
		startMs: tActivate,
		enabled: cfg.get<boolean>('usageLogging', true),
		focused: vscode.window.state.focused,
		sink: (line) => outputChannel?.appendLine(line),
	});
	let lastEditorKey: string | undefined;
	const observeEditor = (initial = false) => {
		const group = vscode.window.tabGroups.activeTabGroup;
		const tab = group.activeTab;
		// ASSUMPTION: VS Code may recreate Tab/input objects for unrelated updates. Compare stable
		// input values instead; the private key stays in memory and never reaches usage records.
		const identity = editorInputIdentity(tab?.input);
		const editorKey = JSON.stringify([group.viewColumn, identity, identity === 'other' || identity.startsWith('view:') ? tab?.label : undefined]);
		usageEditor(classifyEditorInput(tab?.input));
		if (initial || editorKey !== lastEditorKey) {
			recordUsage(initial ? 'editor.observed' : 'editor.changed');
		}
		lastEditorKey = editorKey;
	};
	observeEditor(true);
	const usageTimer = setInterval(emitUsageSummary, 60000);
	usageTimer.unref();
	context.subscriptions.push(
		vscode.window.tabGroups.onDidChangeTabs(() => observeEditor()),
		vscode.window.tabGroups.onDidChangeTabGroups(() => observeEditor()),
		vscode.window.onDidChangeWindowState((state) => usageFocus(state.focused)),
		{ dispose: () => clearInterval(usageTimer) },
	);

	let initializeComparison: ((repositoryReady: () => void) => Promise<void>) | undefined;
	let comparisonInit: Promise<void> | undefined;
	let repositoryReady: Promise<void> | undefined;
	const ensureComparison = async (reason: string): Promise<void> => {
		if (!initializeComparison) { throw new Error('Lighthouse: open a workspace before starting a comparison.'); }
		if (!comparisonInit) {
			milestone('startup.comparisonRequested', { reason });
			sampleHostForMinute();
			let publishRepositoryReady: (() => void) | undefined;
			repositoryReady = new Promise<void>((resolve) => { publishRepositoryReady = resolve; });
			if (!publishRepositoryReady) { throw new Error('Could not create repository readiness signal.'); }
			comparisonInit = initializeComparison(publishRepositoryReady).catch((error) => {
				comparisonInit = undefined;
				milestone('startup.failed');
				log(`Comparison initialization failed: ${errMessage(error)}`);
				void vscode.window.showErrorMessage('Lighthouse: comparison initialization failed. See the Lighthouse output channel.');
				throw error;
			});
		}
		await comparisonInit;
	};
	const ensureRepository = async (): Promise<void> => {
		const initialized = ensureComparison('comparison-data');
		// Observe initialization failures without serializing branch choices behind target discovery.
		await (repositoryReady ? Promise.race([repositoryReady, initialized]) : initialized);
	};
	const independentCommands = new Set([
		'lighthouse.exportStartupDiagnostics', 'lighthouse.openThreadLocation',
		'lighthouse.configureCopilotMcp',
		'lighthouse.viewConversation',
		'lighthouse.createOrReply', 'lighthouse.resolveThread', 'lighthouse.unresolveThread',
		'lighthouse.toggleThreadResolved', 'lighthouse.askCopilotThread', 'lighthouse.askCopilotReview',
		'lighthouse.copyCommitId', 'lighthouse.copyBranchName', 'lighthouse.copyDirPath',
		// ASSUMPTION: explicit refresh starts its feedback before any deferred initialization.
		'lighthouse.refresh', 'lighthouse.refreshAll', 'lighthouse.refreshFiles', 'lighthouse.refreshThreads',
	]);
	const registerCommand = <Args extends unknown[]>(command: string, handler: (...args: Args) => unknown) =>
		vscode.commands.registerCommand(command, async (...args: Args) => {
			observeEditor();
			recordUsage('command.started', { command });
			try {
				if (!independentCommands.has(command)) { await ensureComparison('command'); }
				const result = await handler(...args);
				recordUsage('command.completed', { command });
				return result;
			} catch (error) {
				recordUsage('command.failed', { command });
				throw error;
			}
		});
	const registerPane = (id: string, provider: vscode.WebviewViewProvider, retainContextWhenHidden = false) =>
		vscode.window.registerWebviewViewProvider(id, {
			async resolveWebviewView(view, viewContext, token) {
				// Shells and usage visibility are observable immediately; Git work remains on demand.
				await provider.resolveWebviewView(view, viewContext, token);
				await ensureComparison('pane');
			},
		}, { webviewOptions: { retainContextWhenHidden } });
	context.subscriptions.push(
		registerCommand('lighthouse.configureCopilotMcp', async () => {
			const integration = await import('./mcpConfiguration');
			await integration.configureCopilotMcp(context);
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('lighthouse.perfLogging')) {
				setDiagnosticsEnabled(vscode.workspace.getConfiguration('lighthouse').get<boolean>('perfLogging', true));
			}
			if (e.affectsConfiguration('lighthouse.usageLogging')) {
				setUsageEnabled(vscode.workspace.getConfiguration('lighthouse').get<boolean>('usageLogging', true));
			}
		}),
		registerCommand('lighthouse.exportStartupDiagnostics', async () => {
			const uri = await vscode.window.showSaveDialog({
				title: 'Export Lighthouse startup diagnostics',
				defaultUri: vscode.Uri.joinPath(context.logUri, 'lighthouse-startup.json'),
				filters: { JSON: ['json'] },
			});
			if (!uri) { return; }
			try {
				const report = { trace: diagnosticsSnapshot(), panes: paneSnapshot(), usage: usageSnapshot() };
				await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(report, null, 2), 'utf8'));
				void vscode.window.showInformationMessage('Lighthouse: startup diagnostics exported.');
			} catch (error) {
				void vscode.window.showErrorMessage(`Lighthouse: diagnostic export failed: ${errMessage(error)}`);
			}
		}),
	);
	// ASSUMPTION: GUI and script setup share this marker; do not edit VS Code's private state from a script.
	if (context.extensionPath && path.isAbsolute(context.extensionPath) &&
		(!vscode.env.remoteName || context.extension.extensionKind === vscode.ExtensionKind.Workspace)) {
		void import('fs/promises').then(async (fs) => {
			try { await fs.access(path.join(mcpStorageDirectory(), 'installation.json')); }
			catch (error) {
				if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') { return; }
				throw error;
			}
			const integration = await import('./mcpConfiguration');
			await integration.refreshCopilotMcp(context);
		}).catch(() => {
			void vscode.window.showWarningMessage('Lighthouse MCP refresh could not load. Run Configure Copilot CLI MCP to repair the integration.');
		});
	}

	// ASSUMPTION: these are shared extension-host signals, not CPU/memory attributed to Lighthouse.
	let hostTimer: ReturnType<typeof setInterval> | undefined;
	function sampleHostForMinute(): void {
		if (hostTimer) { clearInterval(hostTimer); }
		let lastSample = now();
		let lastCpu = process.cpuUsage();
		const samplingDeadline = lastSample + 60000;
		hostTimer = setInterval(() => {
			const current = now();
			if (current >= samplingDeadline) { clearInterval(hostTimer); }
			if (diagnosticsEnabled()) {
				const cpu = process.cpuUsage();
				const memory = process.memoryUsage();
				event('host.sample', {
					intervalMs: current - lastSample, eventLoopLagMs: Math.max(0, current - lastSample - 1000),
					cpuUserMs: (cpu.user - lastCpu.user) / 1000, cpuSystemMs: (cpu.system - lastCpu.system) / 1000,
					rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
				});
				lastCpu = cpu;
			} else {
				lastCpu = process.cpuUsage();
			}
			lastSample = current;
		}, 1000);
		hostTimer.unref();
	}
	sampleHostForMinute();
	context.subscriptions.push({ dispose: () => { if (hostTimer) { clearInterval(hostTimer); } } });

	// Load-time instrumentation: header + overall activation timer (gated by lighthouse.perfLogging).
	perfLine('--- activation ---');

	// Status-bar active-review switcher (src → tgt); hidden when there's no review.
	const statusBar = new ReviewStatusBar(context.workspaceState);
	context.subscriptions.push(statusBar);
	void statusBar.update();

	const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!wsFolder) {
		milestone('activation.return', { outcome: 'no-workspace' });
		return;
	}

	// The single in-memory "active comparison" that feeds all review views.
	//
	// ASSUMPTION: subprocess waits and shared extension-host stalls can dominate startup;
	// these timings alone do not establish antivirus causality. Keep activation independent
	// of Git, then minimize the work needed for the first useful comparison.
	const active = new ActiveComparison(wsFolder, wsFolder, context.workspaceState);

	// Inline comment threads. Constructed after `active` so new (first-ever) threads can target
	// the currently-viewed comparison's review even before any comments.json exists on disk.
	const comments = new LighthouseCommentController(() => active, () => ensureComparison('new-discussion'));
	context.subscriptions.push(comments);

	// Three stacked webviews; Comparison owns the selectors and compact commit tree.
	const comparisonProvider = new ComparisonWebviewProvider(
		() => active,
		async (branch) => {
			await ensureComparison('pane-action');
			await active.setBase(branch);
			refreshAll('select-base');
		},
		async (branch) => {
			await ensureComparison('pane-action');
			await active.setCompare(branch);
			refreshAll('select-compare');
		},
		async (row) => {
			await ensureComparison('pane-action');
			await updateStaleBranch(active, row, () => refreshAll('git-operation'), (ok, message) =>
				comparisonProvider.postUpdateResult(row, ok, message),
			);
		},
		ensureRepository,
	);
	const conversationsProvider = new ConversationsWebviewProvider(() => active, context.workspaceState);
	const reviewedFiles = new ReviewedFiles(() => active, () => filesProvider.refreshAvailability(), log);
	context.subscriptions.push(reviewedFiles);
	const filesProvider = new FilesWebviewProvider(
		() => active,
		statusBar,
		() => conversationsProvider.refresh(),
		context.workspaceState,
		reviewedFiles,
	);

	context.subscriptions.push(
		registerPane('lighthouse.comparison', comparisonProvider, true),
	);
	context.subscriptions.push(
		registerPane('lighthouse.files', filesProvider, true),
	);
	// The Conversations pane is now a webview (Phase E). Its thread rows,
	// per-comment #tag badges, resolve/unresolve inline buttons, and
	// click-to-navigate are handled inside ConversationsWebviewProvider's
	// message handling — no TreeView subscription. refresh() re-posts state so
	// the Files->Conversations refresh hook and refreshAll keep working.
	context.subscriptions.push(
		registerPane('lighthouse.conversations', conversationsProvider, true),
	);

	// Seed the show/hide-uncommitted context key from persisted state so the correct title-bar button
	// (Hide vs Show) is present immediately at startup — including for a user who reloads while
	// uncommitted rows are hidden.
	void syncUncommittedContext(context.workspaceState);
	// Same for the Conversations show/hide-resolved buttons.
	void syncResolvedContext(context.workspaceState);

	// Re-post the Files tree when folder compaction is toggled, so flipping the setting updates the
	// pane live instead of requiring a reload.
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('lighthouse.files.compactFolders') || e.affectsConfiguration('lighthouse.files.cumulativeDiff')) {
				filesProvider.refresh();
			}
		}),
	);

	// Refresh all views + inline comments + status bar together.
	const refreshAll = (reason = 'command-or-review-action', comparisonChanged = true, waitForData = false): Promise<void> => {
		const completion = trace('refresh.dispatch', async () => {
			event('refresh.request', { reason });
			reviewedFiles.reconcile(reason);
			const pending: Promise<unknown>[] = [];
			if (reason === 'manual-refresh' || reason === 'manual-resolve-refresh') {
				conversationDocuments.refresh();
				pending.push(conversationPages.refresh(undefined, waitForData));
			}
			if (comparisonChanged) {
				pending.push(comparisonProvider.refresh(['manual-refresh', 'manual-resolve-refresh', 'git-operation'].includes(reason)));
			}
			pending.push(filesProvider.refresh(waitForData), conversationsProvider.refresh(), comments.render(), statusBar.update());
			// Keep feedback active until every dispatched view settles, including partial failures.
			const results = await Promise.allSettled(pending);
			const failure = results.find((result) => result.status === 'rejected');
			if (failure?.status === 'rejected') { throw failure.reason; }
		}, { reason });
		// Automatic callers remain fire-and-forget, but failures are still visible in Output.
		void completion.catch((error) => log(`Could not refresh review views: ${errMessage(error)}`));
		return completion;
	};

	// Read-only content provider that serves historical file blobs for the diff view.
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			DIFF_SCHEME,
			new ReviewDiffContentProvider(),
		),
	);
	const conversationDocuments = new ConversationDocumentProvider();
	const conversationPages = new ConversationPages({
		changed: async () => {
			await active.reloadReview();
			refreshAll('conversation-page');
			conversationDocuments.refresh();
			conversationPages.refresh();
		},
		askCopilot: (reviewFile, threadId) => askCopilot(path.dirname(reviewFile), threadId),
		openCode: async (thread) => {
			if (thread.filePath) {
				await vscode.commands.executeCommand('lighthouse.openThreadLocation', thread.filePath, thread.startLine ?? 1, thread.endLine ?? thread.startLine ?? 1);
			}
		},
	});
	context.subscriptions.push(
		conversationDocuments,
		conversationPages,
		vscode.workspace.registerTextDocumentContentProvider(CONVERSATION_SCHEME, conversationDocuments),
		vscode.window.registerWebviewPanelSerializer(CONVERSATION_PAGE_TYPE, conversationPages),
		registerCommand('lighthouse.viewConversation', async (target: unknown) => {
			try {
				await conversationPages.open(target);
			} catch (error) {
				void vscode.window.showErrorMessage(`Lighthouse: ${errMessage(error)}`);
				throw error;
			}
		}),
		registerCommand('lighthouse.newConversation', async () => {
			if (!active.review) {
				void vscode.window.showWarningMessage('Lighthouse: select a source and target branch before starting a thread.');
				return;
			}
			await conversationPages.openNew({
				...active.review, sourceBranch: active.compare ?? active.review.sourceBranch,
				targetBranch: active.base ?? active.review.targetBranch,
			});
		}),
	);

	// File checkbox toggles are handled inside FilesWebviewProvider.onToggleReviewed
	// (the Files pane is now a webview; the reviewedFiles mutation + persist lives there).

	// Initial inline render.
	void comments.render();

	// /tag autocomplete on the comment input box.
	context.subscriptions.push(registerTagCompletion());

	let refreshRequest = 0;
	const refreshProviders = [comparisonProvider, filesProvider, conversationsProvider];
	let manualRefresh: Promise<void> | undefined;
	const refreshManually = (): Promise<void> => {
		// ASSUMPTION: a manual refresh updates all three panes, so all three show activity.
		// Repeated clicks join the running work without restarting animations or duplicating toasts.
		if (manualRefresh) { return manualRefresh; }
		const id = ++refreshRequest;
		for (const provider of refreshProviders) { provider.setRefreshProgress(id, true); }
		manualRefresh = (async () => {
			try {
				await ensureComparison('manual-refresh');
				await active.resolve();
				await refreshAll('manual-resolve-refresh', true, true);
				if (active.baselineError) {
					void vscode.window.showWarningMessage(`Lighthouse: refresh could not resolve the comparison: ${active.baselineError}`);
				} else if (!active.base || !active.compare) {
					void vscode.window.showInformationMessage('Lighthouse: refresh complete. Select base and compare branches to load a review.');
				} else {
					const count = active.review?.threads.length ?? 0;
					void vscode.window.showInformationMessage(`Lighthouse: comparison, changed files, and local reviews refreshed. ${count} thread${count === 1 ? '' : 's'} loaded.`);
				}
			} catch (error) {
				log(`Manual refresh failed: ${errMessage(error)}`);
				void vscode.window.showErrorMessage(`Lighthouse: refresh failed: ${errMessage(error)}`);
				throw error;
			} finally {
				for (const provider of refreshProviders) { provider.setRefreshProgress(id, false); }
				manualRefresh = undefined;
			}
		})();
		return manualRefresh;
	};

	// Both command-palette refreshes and every pane's title-bar button share this lifecycle.
	context.subscriptions.push(
		registerCommand('lighthouse.refresh', refreshManually),
	);

	// Open a thread's file and reveal `filePath:startLine`.
	context.subscriptions.push(
		registerCommand(
			'lighthouse.openThreadLocation',
			async (filePath: string, startLine: number, endLine: number) => {
				await openThreadLocation(filePath, startLine, endLine);
				// Also expand the matching live CommentThread at that anchor (leaves others as-is).
				await comments.expandThreadAt(filePath, startLine);
			},
		),
	);

	// ── Comment thread commands ────────────────────────────────────────────────
	context.subscriptions.push(
		registerCommand(
			'lighthouse.createOrReply',
			(reply: vscode.CommentReply) => comments.handleReply(reply),
		),
		registerCommand(
			'lighthouse.resolveThread',
			(thread: vscode.CommentThread) => comments.setState(thread, 'resolved'),
		),
		registerCommand(
			'lighthouse.unresolveThread',
			(thread: vscode.CommentThread) => comments.setState(thread, 'unresolved'),
		),
		// Single always-visible in-thread toggle. RATIONALE: the split resolve/reopen title actions
		// depend on the `commentThreadState` context key (when clauses `== unresolved` / `== resolved`),
		// which did not resolve reliably in the host VS Code build — so neither `when` matched and NO
		// button rendered. This one command is keyed only on `commentController == lighthouse`, so it
		// renders unconditionally; the handler reads the thread's current state and flips it.
		registerCommand(
			'lighthouse.toggleThreadResolved',
			async (thread: vscode.CommentThread) => {
				const next =
					thread?.state === vscode.CommentThreadState.Resolved ? 'unresolved' : 'resolved';
				await comments.setState(thread, next);
				// setStateByThreadId writes comments.json but does NOT touch active.review; re-sync the
				// in-memory review so the Conversations pane reflects the flipped state immediately.
				await active.reloadReview();
				conversationsProvider.refresh();
			},
		),
		registerCommand(
			'lighthouse.resolveThreadNode',
			// The Conversations webview posts a { thread: { id } } stub; the former ConversationNode
			// (native TreeItem, deleted in Phase F) satisfied this same minimal shape.
			async (node: { thread?: { id?: string } }) => {
				const reviewFile = active.review?.sourceFile;
				const threadId = node?.thread?.id;
				if (!reviewFile || !threadId) {
					return;
				}
				await comments.setStateByThreadId(reviewFile, threadId, 'resolved');
				await active.reloadReview();
				conversationsProvider.refresh();
			},
		),
		registerCommand(
			'lighthouse.unresolveThreadNode',
			async (node: { thread?: { id?: string } }) => {
				const reviewFile = active.review?.sourceFile;
				const threadId = node?.thread?.id;
				if (!reviewFile || !threadId) {
					return;
				}
				await comments.setStateByThreadId(reviewFile, threadId, 'unresolved');
				await active.reloadReview();
				conversationsProvider.refresh();
			},
		),
		registerCommand(
			'lighthouse.askCopilotThread',
			async (thread: vscode.CommentThread) => {
				const binding = comments.getBinding(thread);
				if (!binding) {
					void vscode.window.showWarningMessage(
						'Lighthouse: this thread is not backed by a review file yet.',
					);
					return;
				}
				askCopilot(binding.reviewDir, binding.threadId);
			},
		),
		registerCommand('lighthouse.askCopilotReview', async () => {
			const review = await pickReview('Select a review for Copilot to look at');
			if (review) {
				askCopilot(path.dirname(review.sourceFile), undefined);
			}
		}),
	);

	// ── Copy commands ──────────────────────────────────────────────────────────
	context.subscriptions.push(
		registerCommand('lighthouse.copyCommitId', async () => {
			const review = await pickReview('Copy commit id from which review?');
			await copyValue(review?.sourceCommit, 'commit id');
		}),
		registerCommand('lighthouse.copyBranchName', async () => {
			const review = await pickReview('Copy branch name from which review?');
			await copyValue(review?.sourceBranch, 'branch name');
		}),
		registerCommand('lighthouse.copyDirPath', async () => {
			const review = await pickReview('Copy directory path from which review?');
			await copyValue(review ? path.dirname(review.sourceFile) : undefined, 'directory path');
		}),
	);

	// ── Git / directory integration (v1.5) ────────────────────────────────────
	context.subscriptions.push(
		registerCommand(
			'lighthouse.pickBranches',
			async (node?: { review?: Review }) => {
				await pickBranches(node?.review, refreshAll);
			},
		),
		registerCommand('lighthouse.switchReview', async () => {
			await switchReview(statusBar, refreshAll);
		}),
		registerCommand(
			'lighthouse.openDirectory',
			async (node?: { review?: Review }) => {
				await openDirectory(node?.review);
			},
		),
		registerCommand('lighthouse.gitPull', async () => {
			await runGit('pull', async () => {
				await active.resolve();
				refreshAll('git-operation');
			});
		}),
		registerCommand('lighthouse.gitPush', async () => {
			await runGit('push', async () => {
				await active.resolve();
				refreshAll('git-operation');
			});
		}),
		registerCommand(
			'lighthouse.openTerminalHere',
			async (node?: { review?: Review }) => {
				await openTerminalHere(node?.review);
			},
		),
	);

	// ── Three-view comparison commands (Commits is embedded) ────────────────────
	context.subscriptions.push(
		registerCommand('lighthouse.pickBase', async () => {
			const chosen = await pickBranch(active.repoRootFsPath, 'Select the base (target) branch', {
				current: active.base,
			});
			if (chosen) {
				await active.setBase(chosen.name);
				refreshAll();
			}
		}),
		registerCommand('lighthouse.pickCompare', async () => {
			const chosen = await pickBranch(
				active.repoRootFsPath,
				'Select the compare (source) branch',
				{ current: active.compare },
			);
			if (chosen) {
				await active.setCompare(chosen.name);
				refreshAll();
			}
		}),
		registerCommand('lighthouse.swapBranches', async () => {
			await active.swap();
			refreshAll();
		}),
		registerCommand('lighthouse.unpinBase', async () => {
			await comparisonProvider.unpinBase(async () => {
				await active.useAutomaticBase();
				refreshAll('unpin-base');
			});
		}),
		registerCommand('lighthouse.copyCompareBranch', () =>
			comparisonProvider.copyCompareBranchName(),
		),
		registerCommand('lighthouse.copyComparePath', () =>
			comparisonProvider.copyCompareBranchPath(),
		),
		registerCommand('lighthouse.refreshAll', refreshManually),
		registerCommand('lighthouse.refreshFiles', refreshManually),
		registerCommand('lighthouse.refreshThreads', refreshManually),
		registerCommand('lighthouse.filesExpandAll', () => {
			filesProvider.setExpanded(true);
		}),
		registerCommand('lighthouse.filesHideUncommitted', async () => {
			await filesProvider.setHideUncommitted(true);
		}),
		registerCommand('lighthouse.filesShowUncommitted', async () => {
			await filesProvider.setHideUncommitted(false);
		}),
		registerCommand('lighthouse.conversationsHideResolved', async () => {
			await conversationsProvider.setHideResolved(true);
		}),
		registerCommand('lighthouse.conversationsShowResolved', async () => {
			await conversationsProvider.setHideResolved(false);
		}),
		registerCommand('lighthouse.collapseAllCommits', () => {
			comparisonProvider.setCommitsExpanded(false);
		}),
		registerCommand('lighthouse.setCommitAsBase', async (commit: unknown) => {
			try {
				await comparisonProvider.setCommitAsBase(commit);
			} catch (error) {
				const message = errMessage(error);
				log(`Set as Base failed: ${message}`);
				void vscode.window.showErrorMessage(`Lighthouse: ${message}`);
			}
		}),
		registerCommand(
			'lighthouse.updateStaleBranch',
			async (row?: 'base' | 'compare') => {
				await updateStaleBranch(active, row, () => refreshAll('git-operation'));
			},
		),
		registerCommand('lighthouse.openFileDiff', async (relPath: string) => {
			await openFileDiff(active, relPath);
		}),
		registerCommand(
			'lighthouse.openUncommittedFileDiff',
			async (relPath: string, group: UncommittedGroup) => {
				await openUncommittedFileDiff(active, relPath, group);
			},
		),
		registerCommand('lighthouse.openCumulativeFileDiff', async (relPath: string) => {
			await openCumulativeFileDiff(active, relPath);
		}),
		registerCommand('lighthouse.openCommitDiff', async (commit: string | { sha?: string }) => {
			const sha = typeof commit === 'string' ? commit : commit?.sha;
			if (sha) { await openCommitDiff(active, sha); }
		}),
		registerCommand(
			'lighthouse.openCommitFileDiff',
			async (sha: string, relPath: string) => {
				await openCommitFileDiff(active, sha, relPath);
			},
		),
		registerCommand('lighthouse.openTerminal', () => {
			const leaf = active.compare ? shortBranch(active.compare) : 'terminal';
			const terminal = vscode.window.createTerminal({
				name: `Lighthouse: ${leaf}`,
				cwd: active.repoRootFsPath,
			});
			terminal.show();
		}),
		registerCommand('lighthouse.commitsViewAllChanges', async () => {
			await openAllChangesDiff(active);
		}),
		registerCommand('lighthouse.copyCommitSha', async (node?: unknown) => {
			const sha =
				typeof node === 'string'
					? node
					: (node as { sha?: string } | undefined)?.sha;
			if (!sha) {
				return;
			}
			await vscode.env.clipboard.writeText(sha);
			void vscode.window.showInformationMessage(`Lighthouse: copied commit ${sha}`);
		}),
	);

	// Keep the tree AND the inline comments in sync with on-disk review files.
	const watcher = vscode.workspace.createFileSystemWatcher(
		'**/.vscode/lighthouse-reviews/**/comments.json',
	);
	const refreshReviews = (uri: vscode.Uri, reason: string): void => {
		conversationDocuments.refresh(uri);
		conversationPages.refresh(uri);
		void active.reloadReview().then(() => refreshAll(reason)).catch((error) => {
			log(`Could not refresh saved reviews: ${errMessage(error)}`);
		});
	};
	watcher.onDidCreate((uri) => refreshReviews(uri, 'review-created'));
	watcher.onDidChange((uri) => refreshReviews(uri, 'review-changed'));
	watcher.onDidDelete((uri) => refreshReviews(uri, 'review-deleted'));
	context.subscriptions.push(watcher);

	// Early startup enables inline discussions and usage observation only. This initializer is
	// invoked later by a pane, comparison command, or new-thread submission, never just by activation.
	perf('activate total', tActivate);

	initializeComparison = (publishRepositoryReady) => {
		const startupSubscriptions: vscode.Disposable[] = [];
		const subscribe = (subscription: vscode.Disposable): void => {
			startupSubscriptions.push(subscription);
			context.subscriptions.push(subscription);
		};
		return trace('startup.background', async () => {
			const tBg = now();
			const gitReady = gitApi.getGitApi();

			const tRepo = now();
			const repository = await trace('startup.repoRoot', () => getRepositoryInfo(wsFolder));
			const repoRoot = repository?.root ?? wsFolder;
			event('startup.repoRootResult', { fallback: !repository });
			perf('getRepoRoot', tRepo);
			active.repoRootFsPath = repoRoot;

			// ASSUMPTION: watches precede captured refs. Initial notifications are covered by the
			// first resolution unless HEAD/refs change during that resolution; never lose that race.
			let initializing = true;
			let comparisonGeneration = 0;
			let pendingResolve = false;
			let stopped = false;
			let watchingRefs = false;
			let headTimer: NodeJS.Timeout | undefined;
			let inFlight = false;
			const onHeadChanged = (reason = 'git-api-state', comparisonChanged = true): void => {
				if (stopped) { return; }
				if (reason === 'ref-changed' || reason === 'ref-created' || reason === 'ref-deleted') {
					comparisonProvider.invalidateBranches();
				}
				if (comparisonChanged) { comparisonGeneration++; }
				pendingResolve ||= comparisonChanged;
				event('refs.refreshRequested', { reason, coalesced: !!headTimer, inFlight, comparisonChanged, initializing });
				if (initializing) { return; }
				if (headTimer) {
					clearTimeout(headTimer);
				}
				headTimer = setTimeout(() => {
					headTimer = undefined;
					if (inFlight) {
						onHeadChanged('retry-in-flight', false);
						return;
					}
					const resolve = pendingResolve;
					pendingResolve = false;
					inFlight = true;
					void (async () => {
						try {
							if (resolve) { await active.resolve(); }
							else { event('refs.resolveSkipped', { reason: 'unchanged-head-and-refs' }); }
							refreshAll(reason, resolve);
						} finally {
							inFlight = false;
						}
					})().catch((error) => {
						log(`Could not refresh repository state: ${errMessage(error)}`);
						void vscode.window.showWarningMessage('Lighthouse: repository refresh failed. Use Refresh to retry.');
					});
				}, 250);
			};
			subscribe({
				dispose: () => {
					stopped = true;
					if (headTimer) { clearTimeout(headTimer); }
				}
			});

			try {
				if (!repository) { throw new Error('Repository metadata is unavailable.'); }
				for (const pattern of [
					new vscode.RelativePattern(vscode.Uri.file(path.dirname(repository.headPath)), '{HEAD,config.worktree}'),
					new vscode.RelativePattern(vscode.Uri.file(repository.commonDir), '{refs/**,packed-refs,config}'),
				]) {
					const watcher = vscode.workspace.createFileSystemWatcher(pattern);
					watcher.onDidChange(() => onHeadChanged('ref-changed'));
					watcher.onDidCreate(() => onHeadChanged('ref-created'));
					watcher.onDidDelete(() => onHeadChanged('ref-deleted'));
					subscribe(watcher);
				}
				watchingRefs = true;
			} catch (error) {
				log(`Could not watch comparison refs: ${errMessage(error)}`);
				void vscode.window.showWarningMessage('Lighthouse: ref watching is unavailable. Use Refresh after updating branches.');
			}

			await gitReady;
			const repoSub = await trace('startup.gitSubscription', () =>
				gitApi.onRepoStateChanged(repoRoot, (change) => {
					// Discovery alone is not a Git mutation. The early filesystem watches cover real changes.
					if (change === 'opened' && watchingRefs && (initializing || active.headCommit)) { return; }
					onHeadChanged(change === 'opened' ? 'git-api-opened' : 'git-api-state', change !== 'working-tree');
				}, (change) => {
					// API discovery cannot stale a disk catalogue when early watches cover mutations.
					if (change !== 'opened' || !watchingRefs) { comparisonProvider.invalidateBranches(); }
				}));
			if (repoSub) {
				subscribe(repoSub);
			}
			comparisonProvider.invalidateBranches();
			milestone('startup.repositoryReady');
			publishRepositoryReady();
			comparisonProvider.refresh();

			const autoCreateOnEmpty = vscode.workspace.getConfiguration('lighthouse').get<boolean>('autoCreateOnEmpty', true);
			let snapshot: ComparisonSnapshot | undefined;
			const snapshotGeneration = comparisonGeneration;
			if (autoCreateOnEmpty && repository && watchingRefs) {
				try {
					snapshot = await trace('startup.comparisonSnapshot', async () => {
						const [head, refs] = await Promise.all([gitApi.getHead(repoRoot), readComparisonRefs(repoRoot)]);
						return { head, refs };
					});
				} catch (error) {
					log(`Could not share startup Git metadata; resolving directly: ${errMessage(error)}`);
					event('startup.snapshotUnavailable');
				}
			}
			if (autoCreateOnEmpty) {
				const tDefaults = now();
				await active.computeDefaults(snapshotGeneration === comparisonGeneration ? snapshot : undefined);
				perf('computeDefaults', tDefaults);
			}
			const resolutionGeneration = comparisonGeneration;
			const tResolve = now();
			await active.resolve(snapshotGeneration === resolutionGeneration ? snapshot : undefined);
			perf('resolve', tResolve);
			initializing = false;
			pendingResolve = false;
			setComparisonSettled();
			milestone('startup.comparisonResolved', { outcome: active.baselineError ? 'error' : active.baselineCommit ? 'ready' : 'unselected' });
			refreshAll('startup');
			if (comparisonGeneration !== resolutionGeneration) { onHeadChanged('startup-raced'); }

			// Auto-reveal: track the active editor in the Changed Files tree. Reveal-only — it never opens
			// or closes an editor, so it cannot fight the user's tab focus.
			subscribe(vscode.window.onDidChangeActiveTextEditor((ed) => filesProvider.revealForUri(ed?.document.uri)));
			// Reveal whatever is already open, so a file open at activation doesn't wait for a tab switch.
			filesProvider.revealForUri(vscode.window.activeTextEditor?.document.uri);
			perf('background init total', tBg);
			milestone('startup.backgroundComplete');
		}).catch((error) => {
			// Failed initialization can be retried; its early watchers must not survive the retry.
			for (const subscription of startupSubscriptions) { subscription.dispose(); }
			throw error;
		});
	};
	event('startup.comparisonDeferred');
	milestone('activation.return');
}

export function deactivate(): void {
	emitUsageSummary();
}

/**
 * Shell out to the Copilot CLI in an integrated terminal rooted at the review dir. The extension
 * NEVER calls a model itself — it only launches the configured CLI. After the CLI writes to
 * comments.json, the file watcher re-renders the thread automatically.
 */
function askCopilot(reviewDir: string, threadId: string | undefined): void {
	const cfg = vscode.workspace.getConfiguration('lighthouse');
	const cliPath = cfg.get<string>('copilotPath', 'copilot');
	const cliArgs = cfg.get<string[]>('copilotArgs', ['-p']);

	const target = threadId
		? `local review thread ${threadId} in ${reviewDir}`
		: `the local review in ${reviewDir}`;
	const prompt =
		`Respond to ${target}. Read comments.json, reply in-thread per the schema ` +
		`(v2: author object, tags[], replyTo), stamp your identity as ~Written by 🤖 Copilot, ` +
		`and set thread state appropriately. Threads without filePath are review-wide threads; ` +
		`answer their messages without inventing a code location.`;

	const terminal = vscode.window.createTerminal({ name: 'Lighthouse · Copilot', cwd: reviewDir });
	terminal.show();
	const quotedArgs = cliArgs.map(shellQuote).join(' ');
	terminal.sendText(`${shellQuote(cliPath)} ${quotedArgs} ${shellQuote(prompt)}`.trim());
}

/** Minimal cross-shell quoting: wrap in double quotes and escape embedded double quotes. */
function shellQuote(value: string): string {
	if (value.length > 0 && !/[\s"'`$&|<>();]/.test(value)) {
		return value;
	}
	return `"${value.replace(/"/g, '\\"')}"`;
}

/** Copy a value to the clipboard with user feedback, or warn when it is missing. */
async function copyValue(value: string | undefined, label: string): Promise<void> {
	if (!value) {
		void vscode.window.showWarningMessage(`Lighthouse: no ${label} available.`);
		return;
	}
	await vscode.env.clipboard.writeText(value);
	void vscode.window.showInformationMessage(`Lighthouse: copied ${label} — ${value}`);
}

/** Pick a review: auto-select when there's one, quick-pick when there are several. */
async function pickReview(placeHolder: string): Promise<Review | undefined> {
	const reviews = await store.scanReviews();
	if (reviews.length === 0) {
		void vscode.window.showWarningMessage('Lighthouse: no review files found.');
		return undefined;
	}
	if (reviews.length === 1) {
		return reviews[0];
	}
	const picks = reviews.map((r) => ({
		label: path.basename(path.dirname(r.sourceFile)),
		description: `${r.sourceBranch ?? '?'} → ${r.targetBranch ?? '?'}`,
		review: r,
	}));
	const chosen = await vscode.window.showQuickPick(picks, { placeHolder });
	return chosen?.review;
}

/**
 * Resolve a repo-relative (forward-slash) path against the workspace folders, open it, and
 * reveal the given 1-based line range with the selection placed on `startLine`.
 */
async function openThreadLocation(
	filePath: string,
	startLine: number,
	endLine: number,
): Promise<void> {
	const uri = await resolveWorkspaceFile(filePath);
	if (!uri) {
		void vscode.window.showWarningMessage(`Lighthouse: could not locate file "${filePath}".`);
		return;
	}

	const doc = await vscode.workspace.openTextDocument(uri);
	const editor = await vscode.window.showTextDocument(doc);

	// Convert 1-based schema lines to 0-based VS Code positions, clamped to the document.
	const lastLine = Math.max(doc.lineCount - 1, 0);
	const startIdx = Math.min(Math.max(startLine - 1, 0), lastLine);
	const endIdx = Math.min(Math.max(endLine - 1, 0), lastLine);
	const endCol = doc.lineAt(endIdx).text.length;

	const range = new vscode.Range(startIdx, 0, endIdx, endCol);
	editor.selection = new vscode.Selection(startIdx, 0, endIdx, endCol);
	editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Try each workspace folder in turn; return the first path that exists. */
async function resolveWorkspaceFile(relPath: string): Promise<vscode.Uri | undefined> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	for (const folder of folders) {
		const candidate = vscode.Uri.joinPath(folder.uri, ...relPath.split('/'));
		try {
			await vscode.workspace.fs.stat(candidate);
			return candidate;
		} catch {
			// Not in this folder; try the next.
		}
	}
	return undefined;
}

// ── v1.5 git / directory integration helpers ─────────────────────────────────

/**
 * Resolve a git working directory for the given review: the workspace folder that owns the review
 * file when available, otherwise the first workspace folder.
 */
function gitCwd(review?: Review): string | undefined {
	if (review) {
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(review.sourceFile));
		if (folder) {
			return folder.uri.fsPath;
		}
	}
	return (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath;
}

/** The configured default push remote, or `undefined` when unset (let git decide). */
function remoteSetting(): string | undefined {
	const value = vscode.workspace.getConfiguration('lighthouse').get<string>('defaultRemote', '');
	return value.trim() ? value.trim() : undefined;
}

function warnNoWorkspace(): void {
	void vscode.window.showWarningMessage('Lighthouse: open a folder/workspace first.');
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A remote ref like `origin/main` also matches a local worktree branch `main`. */
function shortBranch(branch: string): string {
	const idx = branch.indexOf('/');
	return idx >= 0 ? branch.slice(idx + 1) : branch;
}

/** Prompt for one branch (local or remote) from the repo at `cwd`. */
async function pickBranch(
	cwd: string,
	placeHolder: string,
	opts?: { current?: string },
): Promise<BranchRef | undefined> {
	const branches = await gitApi.listBranches(cwd);
	if (branches.length === 0) {
		void vscode.window.showWarningMessage('Lighthouse: no branches found.');
		return undefined;
	}
	const head = await gitApi.getHead(cwd);
	const current = opts?.current;

	type PickItem = vscode.QuickPickItem & { branch?: BranchRef };
	const toItem = (b: BranchRef): PickItem => {
		const isCurrent = b.name === current;
		const isHead = !head.detached && b.kind === 'local' && b.name === head.branch;
		const marks: string[] = [];
		if (isCurrent) {
			marks.push('current');
		}
		if (isHead) {
			marks.push('HEAD');
		}
		return {
			label: `${isCurrent || isHead ? '$(check) ' : ''}${b.name}`,
			description: marks.length > 0 ? `${b.kind} · ${marks.join(', ')}` : b.kind,
			detail: b.commit ? b.commit.slice(0, 12) : undefined,
			branch: b,
		};
	};

	const locals = branches.filter((b) => b.kind === 'local');
	const remotes = branches.filter((b) => b.kind === 'remote');
	const items: PickItem[] = [];
	if (locals.length > 0) {
		items.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator });
		items.push(...locals.map(toItem));
	}
	if (remotes.length > 0) {
		items.push({ label: 'Remote', kind: vscode.QuickPickItemKind.Separator });
		items.push(...remotes.map(toItem));
	}

	const chosen = await vscode.window.showQuickPick(items, {
		placeHolder,
		matchOnDescription: true,
	});
	return chosen?.branch;
}

/**
 * Fast-forward a stale comparison row's branch to its upstream. Fetches first, then:
 *   - if the row's branch is the currently checked-out HEAD → `git merge --ff-only <upstream>`;
 *   - otherwise → `git fetch . <upstream>:<branch>` (FF-only ref update, refuses non-FF).
 * On non-FF divergence, warns and does NOT merge/rebase. On success, re-resolves + refreshes.
 */
async function updateStaleBranch(
	active: ActiveComparison,
	row: 'base' | 'compare' | undefined,
	refreshAll: () => void,
	report?: (ok: boolean, message?: string) => void,
): Promise<void> {
	const branch = row === 'compare' ? active.compare : active.base;
	if (!branch) {
		const msg = 'no branch selected to update.';
		void vscode.window.showWarningMessage(`Lighthouse: ${msg}`);
		report?.(false, msg);
		return;
	}
	if (branch.includes('/')) {
		const msg = `'${branch}' is a remote-tracking branch and cannot be fast-forwarded.`;
		log(`⚠ ${msg}`);
		void vscode.window.showWarningMessage(`Lighthouse: ${msg}`);
		report?.(false, msg);
		return;
	}
	const cwd = active.repoRootFsPath;
	// Immediate feedback the instant the op starts, before any git work runs.
	vscode.window.setStatusBarMessage(`Lighthouse: updating '${branch}'…`, 2000);
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: `Lighthouse: updating '${branch}'…` },
		async () => {
			try {
				log(`⇣ Fetching origin for '${branch}'…`);
				await gitFetch(cwd);
				const ab = await aheadBehind(cwd, branch);
				if (!ab || ab.behind === 0) {
					log(`Already up to date: '${branch}'.`);
					vscode.window.setStatusBarMessage(`Lighthouse: '${branch}' already up to date`, 4000);
					void vscode.window.showInformationMessage(
						`Lighthouse: '${branch}' is already up to date.`,
					);
					await active.resolve();
					refreshAll();
					report?.(true);
					return;
				}
				log(`'${branch}' is ⇣${ab.behind} behind ${ab.upstream}; attempting fast-forward…`);
				const head = await gitApi.getHead(cwd);
				const isHead = !head.detached && branch === head.branch;
				const ok = isHead
					? await fastForward(cwd, ab.upstream)
					: await fastForwardRef(cwd, ab.upstream, branch);
				if (!ok) {
					const msg = `Cannot fast-forward '${branch}' — diverged from ${ab.upstream}; resolve manually.`;
					log(`⚠ ${msg}`);
					log('Click ↻ Update again to retry.');
					vscode.window.setStatusBarMessage(`Lighthouse: '${branch}' cannot fast-forward`, 5000);
					void vscode.window.showWarningMessage(`Lighthouse: ${msg}`);
					report?.(false, msg);
					return;
				}
				log(`Fast-forwarded '${branch}' to ${ab.upstream}.`);
				vscode.window.setStatusBarMessage(`Lighthouse: fast-forwarded '${branch}'`, 4000);
				void vscode.window.showInformationMessage(
					`Lighthouse: fast-forwarded '${branch}' to ${ab.upstream}.`,
				);
				await active.resolve();
				refreshAll();
				report?.(true);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log(`⚠ Update failed for '${branch}': ${msg}`);
				log('Click ↻ Update again to retry.');
				vscode.window.setStatusBarMessage(`Lighthouse: update failed for '${branch}'`, 5000);
				void vscode.window.showWarningMessage(`Lighthouse: update failed for '${branch}': ${msg}`);
				report?.(false, msg);
			}
		},
	);
}

/**
 * Pick a source and target branch for a review and persist the choice (branch + commit) into its
 * comments.json header via the v2 writer. Keeps v1/v2 read back-compat because we reload → mutate →
 * save through reviewStore.
 */
async function pickBranches(review: Review | undefined, refreshAll: () => void): Promise<void> {
	const target = review ?? (await pickReview('Pick branches for which review?'));
	if (!target) {
		return;
	}
	const cwd = gitCwd(target);
	if (!cwd) {
		warnNoWorkspace();
		return;
	}
	if (!(await gitApi.hasRepository(cwd))) {
		void vscode.window.showErrorMessage('Lighthouse: no git repository in the workspace.');
		return;
	}
	const source = await pickBranch(cwd, 'Select SOURCE branch (the changes under review)');
	if (!source) {
		return;
	}
	const base = await pickBranch(cwd, 'Select TARGET branch (the base to compare against)');
	if (!base) {
		return;
	}

	await store.updateReview(target.sourceFile, (fresh) => {
		fresh.sourceBranch = source.name;
		fresh.sourceCommit = source.commit;
		fresh.targetBranch = base.name;
		fresh.targetCommit = base.commit;
	});
	void vscode.window.showInformationMessage(
		`Lighthouse: review set to ${source.name} → ${base.name}.`,
	);
	refreshAll();
}

/**
 * Choose the active review for the status bar. With a single review, jump straight to the branch
 * pickers; with several, pick one and mark it active.
 */
async function switchReview(statusBar: ReviewStatusBar, refreshAll: () => void): Promise<void> {
	const reviews = await store.scanReviews();
	if (reviews.length === 0) {
		void vscode.window.showWarningMessage('Lighthouse: no review files found.');
		return;
	}
	if (reviews.length === 1) {
		await statusBar.setActiveDir(path.dirname(reviews[0].sourceFile));
		await pickBranches(reviews[0], refreshAll);
		return;
	}
	const items = reviews.map((r) => ({
		label: path.basename(path.dirname(r.sourceFile)),
		description: `${r.sourceBranch ?? '?'} → ${r.targetBranch ?? '?'}`,
		review: r,
	}));
	const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Select the active review' });
	if (!chosen) {
		return;
	}
	await statusBar.setActiveDir(path.dirname(chosen.review.sourceFile));
	refreshAll();
}

/**
 * Worktree-aware "open directory": from a review's source/target branch, find a matching local
 * worktree and offer to open it in a new window or reveal it. If the branch isn't checked out
 * anywhere, say so gracefully.
 */
async function openDirectory(review?: Review): Promise<void> {
	const target = review ?? (await pickReview('Open directory for which review?'));
	if (!target) {
		return;
	}
	const cwd = gitCwd(target);
	if (!cwd) {
		warnNoWorkspace();
		return;
	}
	const candidates = [target.sourceBranch, target.targetBranch].filter(
		(b): b is string => !!b,
	);
	if (candidates.length === 0) {
		void vscode.window.showInformationMessage(
			'Lighthouse: this review has no branches set — run "Pick Branches" first.',
		);
		return;
	}
	let branch: string | undefined = candidates[0];
	if (candidates.length > 1) {
		branch = await vscode.window.showQuickPick(candidates, {
			placeHolder: "Which branch's directory?",
		});
	}
	if (!branch) {
		return;
	}

	const worktrees = await gitApi.listWorktrees(cwd);
	const short = shortBranch(branch);
	const match = worktrees.find((w) => w.branch === branch || w.branch === short);
	if (!match) {
		void vscode.window.showInformationMessage(
			`Lighthouse: branch "${branch}" is not checked out in any worktree.`,
		);
		return;
	}

	const OPEN = 'Open Folder (new window)';
	const REVEAL = 'Reveal in OS';
	const action = await vscode.window.showQuickPick([OPEN, REVEAL], { placeHolder: match.path });
	const uri = vscode.Uri.file(match.path);
	if (action === OPEN) {
		await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
	} else if (action === REVEAL) {
		await vscode.commands.executeCommand('revealFileInOS', uri);
	}
}

/** git pull / push one-click, preferring the vscode.git API with a CLI fallback. */
async function runGit(op: 'pull' | 'push', refreshAll: () => void | Promise<void>): Promise<void> {
	const cwd = gitCwd();
	if (!cwd) {
		warnNoWorkspace();
		return;
	}
	if (!(await gitApi.hasRepository(cwd))) {
		void vscode.window.showErrorMessage('Lighthouse: no git repository in the workspace.');
		return;
	}
	if (op === 'push') {
		const head = await gitApi.getHead(cwd);
		if (head.detached) {
			void vscode.window.showErrorMessage('Lighthouse: cannot push a detached HEAD.');
			return;
		}
	}
	const remote = op === 'push' ? remoteSetting() : undefined;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Lighthouse: git ${op}…` },
		async () => {
			try {
				if (op === 'pull') {
					await gitApi.pull(cwd);
				} else {
					await gitApi.push(cwd, remote);
				}
				void vscode.window.showInformationMessage(`Lighthouse: git ${op} succeeded.`);
				await refreshAll();
			} catch (err) {
				void vscode.window.showErrorMessage(
					`Lighthouse: git ${op} failed — ${errMessage(err)}`,
				);
			}
		},
	);
}

/** Open an integrated terminal rooted at the review dir (or the repo root). */
async function openTerminalHere(review?: Review): Promise<void> {
	let cwd = review ? path.dirname(review.sourceFile) : undefined;
	if (!cwd) {
		const base = gitCwd();
		cwd = base ? (await getRepoRoot(base)) ?? base : undefined;
	}
	if (!cwd) {
		warnNoWorkspace();
		return;
	}
	const terminal = vscode.window.createTerminal({ name: 'Lighthouse · Terminal', cwd });
	terminal.show();
}
