const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const manifest = require(path.join(root, 'package.json'));
const result = esbuild.buildSync({
	entryPoints: {
		server: path.join(root, 'src', 'mcp', 'server.ts'),
		setup: path.join(root, 'src', 'mcp', 'setup.ts'),
	},
	outdir: path.join(root, 'out', 'mcp'),
	outExtension: { '.js': '.cjs' },
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	legalComments: 'linked',
	metafile: true,
	define: { LIGHTHOUSE_VERSION: JSON.stringify(manifest.version) },
});
// ASSUMPTION: dependencies are bundled; license files must travel with the standalone payload.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
	if (!input.includes('node_modules')) { continue; }
	let directory = path.dirname(path.resolve(input));
	while (directory !== path.dirname(directory)) {
		const file = path.join(directory, 'package.json');
		if (fs.existsSync(file)) {
			const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (pkg.name && pkg.version) { packages.set(directory, `${pkg.name}@${pkg.version}`); break; }
		}
		directory = path.dirname(directory);
	}
}
const licenses = [...packages].sort((a, b) => a[1].localeCompare(b[1])).map(([directory, name]) => {
	const files = fs.readdirSync(directory).filter((file) => /^(licen[cs]e|copying)([.-]|$)/i.test(file) && fs.statSync(path.join(directory, file)).isFile());
	if (!files.length) { throw new Error(`Missing bundled dependency license: ${name}`); }
	return `=== ${name} ===\n${files.map((file) => fs.readFileSync(path.join(directory, file), 'utf8')).join('\n')}`;
});
fs.writeFileSync(path.join(root, 'out', 'mcp', 'THIRD-PARTY-NOTICES.txt'), licenses.join('\n\n'), 'utf8');
