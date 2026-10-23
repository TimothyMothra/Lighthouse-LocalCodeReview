export const WEBVIEW_PROGRESS_CSS = `
.commit-progress { height: 2px; flex: 0 0 auto; overflow: hidden; position: relative; }
/* ASSUMPTION: the 2px progress slot stays reserved, so loading never moves the rows. */
.commit-progress[hidden] { display: block; visibility: hidden; }
.commit-progress[hidden]::before { animation: none; }
.commit-progress::before {
	content: ''; position: absolute; left: 0; width: 2%; height: 100%;
	background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
	/* ASSUMPTION: essential progress motion stays enabled, as in VS Code's native progress bar. */
	animation: commit-progress-slide 4s linear infinite;
}
@keyframes commit-progress-slide {
	from { transform: translateX(0%) scaleX(1); }
	50% { transform: translateX(2500%) scaleX(3); }
	to { transform: translateX(4900%) scaleX(1); }
}
`;

export const WEBVIEW_PROGRESS_JS = `
function createRefreshProgress(progress, redraw) {
	let requestId = 0;
	let running = false;
	let completedCycle = true;
	function visible() { return running || !completedCycle; }
	function update() {
		if (redraw) { redraw(); } else { progress.hidden = !visible(); }
	}
	function start(id) {
		if (id < requestId || (id === requestId && running)) { return; }
		requestId = id;
		running = true;
		completedCycle = false;
		// ASSUMPTION: each explicit refresh deserves a full visible sweep, not a host-side delay.
		// Flush the hidden state to restart the CSS animation even when another sweep was active.
		progress.hidden = true;
		void progress.offsetWidth;
		update();
	}
	function end(id) {
		if (id !== requestId) { return; }
		running = false;
		update();
	}
	progress.addEventListener('animationiteration', (event) => {
		if (event.animationName !== 'commit-progress-slide') { return; }
		completedCycle = true;
		update();
	});
	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message.type === 'refreshProgress') {
			if (message.running) { start(message.id); } else { end(message.id); }
		}
	});
	return { start, end, visible };
}
`;
