const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { loadProfiles, catalogCommand } = require('../src/core');

const workspace = path.resolve(process.argv[2] || '../../..');
const file = path.join(workspace, '.vscode', 'odoo-update.json');
const profiles = loadProfiles(file, workspace);
const script = fs.readFileSync(path.join(__dirname, '../src/catalog.py'), 'utf8');

function read(profile, request) {
    const command = catalogCommand(profile, script, request);
    const result = spawnSync(command.command, command.args, { cwd: profile.cwd, input: command.input,
        encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    const response = JSON.parse(result.stdout);
    assert(response.ok, response.error || result.stderr);
    return response.result;
}

for (const profile of profiles) {
    const databases = read(profile, { mode: 'databases' }).databases;
    assert(databases.length > 0, 'No databases visible');
    const database = profile.database || databases[0];
    const result = read(profile, { mode: 'modules', database });
    assert(result.version.startsWith('17.'));
    assert(result.modules.some((item) => item.name === 'base'));
    const candidate = result.modules.find((item) => item.available && item.installable && item.state === 'installed' && item.kind === 'extra') ||
        result.modules.find((item) => item.name === 'base' && item.state === 'installed');
    assert(candidate, 'No installed modules');
    const plan = read(profile, { mode: 'plan', database, module: candidate.name }).plan;
    assert(plan.some((item) => item.name === candidate.name));
    console.log(`${profile.id}: Odoo ${result.version}, ${result.addonsPaths.length} addon paths, ${result.modules.length} modules, read-only plan OK`);
}
