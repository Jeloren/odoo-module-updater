const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const metadata = require('../package.json');

const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const result = spawnSync(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package',
    '--no-dependencies', '--allow-missing-repository', '--out',
    path.join(root, 'dist', `odoo-module-updater-${metadata.version}.vsix`)], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
