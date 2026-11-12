const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LayoutQueue, locateLayoutTarget } = require('../src/layout');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function files(t) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-layout-'));
    const root = path.join(folder, 'demo');
    fs.mkdirSync(root);
    for (const file of ['__manifest__.py', 'view.xml', 'asset.xml', 'model.py']) fs.writeFileSync(path.join(root, file), '');
    t.after(() => fs.rmSync(folder, { recursive: true }));
    return { root, files: new Set([path.join(root, 'view.xml')]) };
}

test('layout binds the exact installed checkout and only manifest data XML', (t) => {
    const { root } = files(t);
    const modules = [{ name: 'demo', path: root, available: true, installable: true, state: 'installed', dataFiles: ['view.xml', '../escape.xml'] }];
    assert.equal(locateLayoutTarget(path.join(root, 'view.xml'), modules).module, 'demo');
    assert.throws(() => locateLayoutTarget(path.join(root, 'asset.xml'), modules), /data manifest/);
    assert.throws(() => locateLayoutTarget(path.join(root, 'model.py'), modules), /XML/);
    assert.throws(() => locateLayoutTarget(path.join(root, 'view.xml'), [{ ...modules[0], path: '/different/demo' }]), /Путь модуля/);
});

test('rapid saves debounce; saves in flight produce just one serial follow-up', async (t) => {
    const target = files(t);
    let calls = 0;
    let active = 0;
    let maximum = 0;
    const queue = new LayoutQueue(async () => {
        calls++; active++; maximum = Math.max(maximum, active);
        await wait(60); active--;
    }, { delay: 20 });
    t.after(() => queue.disable());
    queue.enable(target);
    for (let i = 0; i < 5; i++) queue.saved([...target.files][0]);
    await wait(35);
    assert.equal(calls, 1);
    for (let i = 0; i < 5; i++) queue.saved([...target.files][0]);
    await wait(150);
    assert.equal(calls, 2);
    assert.equal(maximum, 1);
});

test('disable drops pending work but does not pretend to cancel an in-flight update', async (t) => {
    const target = files(t);
    let calls = 0;
    const queue = new LayoutQueue(async () => { calls++; await wait(50); }, { delay: 10 });
    queue.enable(target); queue.saved([...target.files][0]); queue.disable();
    await wait(30); assert.equal(calls, 0);
    queue.enable(target); queue.saved([...target.files][0]);
    await wait(20); queue.saved([...target.files][0]); queue.disable();
    await wait(90); assert.equal(calls, 1);
});

test('failure pauses layout; manifest change and unrelated assets never trigger upgrade', async (t) => {
    const target = files(t);
    let calls = 0;
    const errors = [];
    const queue = new LayoutQueue(async () => { calls++; throw new Error('Invalid XML'); }, { delay: 10, onError: (e) => errors.push(e.message) });
    queue.enable(target); queue.saved(path.join(target.root, 'asset.xml'));
    await wait(20); assert.equal(calls, 0);
    queue.saved([...target.files][0]); await wait(30);
    queue.saved([...target.files][0]); await wait(30);
    assert.equal(calls, 1); assert.equal(queue.enabled, false); assert.deepEqual(errors, ['Invalid XML']);
    queue.enable(target); queue.saved(path.join(target.root, '__manifest__.py'));
    assert.equal(queue.enabled, false);
});
