const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadProfiles, catalogCommand, upgradeCommand, runtimeKey, runUpgrade } = require('../src/core');

const docker = { type: 'docker', composeFiles: ['/project/docker compose.yml'], service: 'erp',
    python: 'python3', odooBin: '/opt/odoo/odoo-bin', config: '/etc/odoo/dev.conf' };
const local = { type: 'local', python: '/venv/python', odooBin: '/source with spaces/odoo-bin',
    config: '/private config.conf', serverAlreadyStopped: true };

test('paths resolve against the workspace, commands stay argument arrays', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-updater-test-'));
    const file = path.join(directory, 'odoo-update.json');
    try {
        fs.writeFileSync(file, JSON.stringify({ version: 1, profiles: { docker: {
            ...docker, composeFiles: ['docker/docker-compose.yml'], cwd: '${workspaceFolder}',
        } } }));
        const [profile] = loadProfiles(file, directory);
        assert.equal(profile.composeFiles[0], path.join(directory, 'docker/docker-compose.yml'));
        const catalog = catalogCommand(profile, 'print(1)', { mode: 'modules', database: 'db name' });
        assert(catalog.args.includes('print(1)'));
        assert.equal(JSON.parse(catalog.input).database, 'db name');
    } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(directory);
    }
});

test('local upgrade preserves spaces and uses addons override for both operations', () => {
    const profile = { ...local, addonsPath: ['/custom addons', '/enterprise'] };
    const upgrade = upgradeCommand(profile, 'my database', 'sale_custom');
    assert.equal(upgrade.args[0], local.odooBin);
    assert.equal(upgrade.args[upgrade.args.indexOf('-d') + 1], 'my database');
    assert.equal(upgrade.args.at(-1), '/custom addons,/enterprise');
    assert.deepEqual(JSON.parse(catalogCommand(profile, '', {}).input).addonsPath, profile.addonsPath);
    assert.throws(() => upgradeCommand(profile, 'db', 'all'));
    assert.throws(() => upgradeCommand(profile, 'db', 'module; rm -rf /'));
    assert.throws(() => upgradeCommand({ ...local, serverAlreadyStopped: false }, 'db', 'sale'));
});

test('Docker server is restored after upgrade failure', async () => {
    const operations = [];
    await assert.rejects(runUpgrade(docker, 'dev', 'sale_custom', async (command) => {
        const op = command.args[3];
        operations.push(op);
        if (op === 'ps') return 'container-id';
        if (op === 'run') throw new Error('Invalid XML');
        return '';
    }), /Invalid XML/);
    assert.deepEqual(operations, ['ps', 'stop', 'run', 'start']);
});

test('Docker server initially stopped stays stopped', async () => {
    const operations = [];
    await runUpgrade(docker, 'dev', 'sale_custom', async (command) => {
        operations.push(command.args[3]);
        return '';
    });
    assert.deepEqual(operations, ['ps', 'run']);
});

test('local hooks run in order and both failures remain visible', async () => {
    const operations = [];
    const profile = { ...local, stopCommand: { command: 'stop-service', args: [] },
        startCommand: { command: 'start-service', args: [] } };
    await assert.rejects(runUpgrade(profile, 'dev', 'sale', async (command) => {
        operations.push(command.command);
        if (command.command === local.python) throw new Error('upgrade failed');
        if (command.command === 'start-service') throw new Error('start failed');
        return '';
    }), (error) => error.message.includes('upgrade failed') && error.message.includes('start failed'));
    assert.deepEqual(operations, ['stop-service', local.python, 'start-service']);
});

test('lock identity covers the server, shared by databases and workspaces', () => {
    assert.equal(runtimeKey(docker), runtimeKey({ ...docker, database: 'other', workspace: '/another' }));
    assert.notEqual(runtimeKey(docker), runtimeKey({ ...docker, service: 'other' }));
});

test('RPC profile is explicit, validates endpoint, and leaves old profiles on CLI', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-rpc-config-'));
    const file = path.join(directory, 'settings.json');
    const load = (entry) => { fs.writeFileSync(file, JSON.stringify({version:1, profiles:{dev:entry}})); return loadProfiles(file,directory)[0]; };
    try {
        assert.equal(load(local).updateMode, 'cli');
        assert.equal(load({...local, updateMode:'rpc', serverUrl:'http://127.0.0.1:8069/', login:'admin'}).serverUrl, 'http://127.0.0.1:8069');
        for (const serverUrl of ['file:///tmp', 'http://user:secret@localhost', 'http://example.org', 'https://example.org/?password=x']) {
            assert.throws(()=>load({...local, updateMode:'rpc', serverUrl, login:'admin'}));
        }
        assert.throws(()=>load({...local, updateMode:'rpc', serverUrl:'http://localhost:8069'}));
        assert.throws(()=>load({...local, updateMode:'unknown'}));
    } finally { fs.rmSync(directory,{recursive:true}); }
});
