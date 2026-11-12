const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

test('remembered target updates without another picker, uninstall clears it', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-updater-ui-'));
    const settings = path.join(directory, '.vscode');
    const storage = path.join(directory, 'storage');
    fs.mkdirSync(settings);
    fs.writeFileSync(path.join(settings, 'odoo-update.json'), JSON.stringify({ version: 1, profiles: { dev: {
        type: 'docker', composeFiles: ['compose.yml'], service: 'erp', python: 'python3',
        odooBin: '/odoo-bin', config: '/odoo.conf',
    } } }));
    const commands = new Map();
    const state = new Map();
    const operations = [];
    let picks = 0;
    let installed = true;
    let failUpgrade = false;
    const vscode = {
        workspace: { onDidSaveTextDocument: () => ({ dispose() {} }), isTrusted: true, workspaceFolders: [{ uri: { fsPath: directory } }] },
        StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
        EventEmitter: class { constructor() { this.event = () => {}; } fire() {} dispose() {} },
        commands: { registerCommand(id, callback) { commands.set(id, callback); return { dispose() {} }; } },
        window: {
            createOutputChannel: () => ({ show() {}, append() {}, appendLine() {}, dispose() {} }),
            createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
            registerTreeDataProvider: () => ({ dispose() {} }),
            async showQuickPick(items) { picks++; return items[0]; },
            showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
            withProgress: (_options, callback) => callback(),
        },
    };
    const original = Module._load;
    Module._load = function (id, ...args) {
        if (id === 'vscode') return vscode;
        if (id === 'node:child_process') return { spawn(_program, args) {
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.stdin = new PassThrough();
            let input = '';
            child.stdin.on('data', (chunk) => { input += chunk; });
            child.stdin.on('finish', () => setImmediate(() => {
                const op = args[3];
                let response = '';
                if (args.includes('-c') && !args.includes('-u')) {
                    const request = JSON.parse(input);
                    const addon = { name: 'custom', title: 'Custom', state: installed ? 'installed' : 'uninstalled',
                        available: true, installable: true, path: '/addons/custom', kind: 'extra' };
                    response = JSON.stringify({ ok: true, result: request.mode === 'databases'
                        ? { databases: ['dev_db'] } : { modules: [addon], plan: [addon] } });
                } else {
                    operations.push(op);
                    if (op === 'ps') response = 'container-id';
                }
                child.stdout.end(response);
                child.emit('close', args.includes('-u') && failUpgrade ? 1 : 0);
            }));
            return child;
        } };
        return original.call(this, id, ...args);
    };
    try {
        const { activate } = require('../src/extension');
        activate({ subscriptions: [], globalStorageUri: { fsPath: storage },
            asAbsolutePath: (file) => path.resolve(__dirname, '..', file),
            workspaceState: { get: (key, fallback) => state.get(key) ?? fallback,
                update: async (key, value) => state.set(key, value) },
        });
        await new Promise((resolve) => setImmediate(resolve));
        const update = commands.get('odooUpdate.update');
        await update();
        assert.equal(picks, 2);
        assert.deepEqual(operations, ['ps', 'stop', 'run', 'start']);
        failUpgrade = true;
        await update();
        assert.equal(picks, 2);
        assert.equal(operations.at(-1), 'start');
        assert.deepEqual(fs.readdirSync(storage), []);
        installed = false;
        const before = operations.length;
        await update();
        assert.equal(operations.length, before);
        const target = [...state.entries()].find(([key]) => key.startsWith('odooUpdate.target.'))[1];
        assert.deepEqual(target, { database: 'dev_db' });
    } finally {
        Module._load = original;
        fs.unlinkSync(path.join(settings, 'odoo-update.json'));
        fs.rmdirSync(settings);
        if (fs.existsSync(storage)) fs.rmdirSync(storage);
        fs.rmdirSync(directory);
    }
});
