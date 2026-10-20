const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repository = path.resolve(__dirname, '..');

function calendarParts(version) {
	if (typeof version !== 'string' || !/^[1-9]\d{3}\.[1-9]\d{0,3}\.[1-9]\d*$/.test(version)) {
		throw new Error('Build versions must use YYYY.MMDD.revision without leading zeros.');
	}
	const [year, monthDay, revision] = version.split('.').map(Number);
	const month = Math.floor(monthDay / 100), day = monthDay % 100;
	const date = new Date(Date.UTC(year, month - 1, day));
	if (!Number.isSafeInteger(revision) || revision > 2147483647 ||
		date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		throw new Error(`Invalid calendar build version: ${version}`);
	}
	return { year, monthDay, revision };
}

function localCalendar(now) {
	return { year: now.getFullYear(), monthDay: (now.getMonth() + 1) * 100 + now.getDate() };
}

function nextVersion(current, now = new Date()) {
	const previous = calendarParts(current), today = localCalendar(now);
	const difference = today.year - previous.year || today.monthDay - previous.monthDay;
	if (difference < 0) { throw new Error('The manifest is future-dated. Refusing to backdate or downgrade the build version.'); }
	const revision = difference === 0 ? previous.revision + 1 : 1;
	const next = `${today.year}.${today.monthDay}.${revision}`;
	calendarParts(next);
	return next;
}

function json(file) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
	catch { throw new Error(`Cannot read valid JSON from ${path.basename(file)}. No version was prepared.`); }
}

function state(root) {
	const manifest = json(path.join(root, 'package.json')), lock = json(path.join(root, 'package-lock.json'));
	const containers = manifest.contributes?.viewsContainers?.activitybar;
	const views = Array.isArray(containers) ? containers.filter((item) => item.id === 'lighthouse') : [];
	if (views.length !== 1 || typeof manifest.displayName !== 'string') { throw new Error('The Lighthouse Activity Bar container/display name is missing or ambiguous.'); }
	return { manifest, lock, container: views[0] };
}

function checkVersion(root = repository, now = new Date(), requireToday = true) {
	const current = state(root), parts = calendarParts(current.manifest.version), today = localCalendar(now);
	if (current.lock.version !== current.manifest.version || current.lock.packages?.['']?.version !== current.manifest.version ||
		current.container.title !== `${current.manifest.displayName} (${current.manifest.version})`) {
		throw new Error('Build metadata is inconsistent: synchronize package.json, both lockfile version fields, and the Activity Bar title before packaging.');
	}
	if (requireToday && (parts.year !== today.year || parts.monthDay !== today.monthDay)) {
		throw new Error(`Stale build version ${current.manifest.version}: a new package today must use ${today.year}.${today.monthDay}.revision. Run npm run version:prepare, then package again.`);
	}
	return current.manifest.version;
}

function prepareVersion(root = repository, now = new Date(), npmCli = process.env.npm_execpath) {
	const previous = checkVersion(root, now, false), next = nextVersion(previous, now);
	if (!npmCli || !path.isAbsolute(npmCli) || !fs.existsSync(npmCli)) {
		throw new Error('Run preparation through npm run version:prepare so the installed npm CLI is selected safely.');
	}
	// ASSUMPTION: only new-build entry points prepare. VSCE's prepublish hook checks without incrementing again.
	execFileSync(process.execPath, [npmCli, 'version', next, '--no-git-tag-version', '--ignore-scripts', '--offline'], {
		cwd: root, windowsHide: true, stdio: 'pipe',
	});
	const manifestFile = path.join(root, 'package.json'), original = fs.readFileSync(manifestFile, 'utf8');
	const manifest = JSON.parse(original);
	const container = manifest.contributes.viewsContainers.activitybar.find((item) => item.id === 'lighthouse');
	container.title = `${manifest.displayName} (${next})`;
	if (fs.readFileSync(manifestFile, 'utf8') !== original) { throw new Error('The manifest changed during version preparation. Stop and reconcile it before packaging.'); }
	fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
	return checkVersion(root, now);
}

module.exports = { calendarParts, nextVersion, checkVersion, prepareVersion };

if (require.main === module) {
	try {
		const action = process.argv[2];
		if (action !== 'prepare' && action !== 'check') { throw new Error('Usage: npm run version:prepare | npm run version:check'); }
		const version = action === 'prepare' ? prepareVersion() : checkVersion();
		process.stdout.write(`Lighthouse build version ${action === 'prepare' ? 'prepared' : 'checked'}: ${version}\n`);
	} catch (error) {
		process.stderr.write(`Lighthouse version check failed: ${error.message}\n`);
		process.exitCode = 1;
	}
}
