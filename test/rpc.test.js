const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { OdooRpc } = require('../src/rpc');

async function fixture(t, behavior = {}) {
    const calls = [];
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        calls.push({ route: req.url, params: request.params, cookie: req.headers.cookie });
        if (req.url.endsWith('authenticate')) {
            res.setHeader('Set-Cookie', 'session_id=fake; HttpOnly; Path=/');
            if (behavior.badLogin) return res.end(JSON.stringify({ id: 1, error: { data: { name: 'odoo.exceptions.AccessDenied', message: 'Access Denied' } } }));
            return res.end(JSON.stringify({ id: 1, result: { uid: 2, server_version_info: [17, 0], db: request.params.db } }));
        }
        if (req.url.endsWith('call_kw')) return res.end(JSON.stringify({ id: 1, result: behavior.missing ? [] : [{ id: 42, name: 'demo' }] }));
        if (behavior.drop) return req.socket.destroy();
        if (behavior.timeout) return;
        if (behavior.invalid) return res.end('bad response');
        if (behavior.error) return res.end(JSON.stringify({ id: 1, error: { data: { name: 'odoo.exceptions.UserError', message: 'Invalid XML' } } }));
        res.end(JSON.stringify({ id: 1, result: { type: 'ir.actions.client', tag: 'reload' } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    return { profile: { serverUrl: `http://127.0.0.1:${server.address().port}`, login: 'admin' }, calls };
}

test('RPC uses the selected database and module and reuses only the matching session', async (t) => {
    const { profile, calls } = await fixture(t);
    const rpc = new OdooRpc();
    let passwordReads = 0;
    const secret = async () => { passwordReads++; return 'fake-secret'; };
    await rpc.upgrade(profile, 'one', 'demo', secret);
    await rpc.upgrade(profile, 'one', 'demo', secret);
    await rpc.upgrade(profile, 'two', 'demo', secret);
    assert.equal(passwordReads, 2);
    assert.deepEqual(calls.filter((c) => c.route.endsWith('authenticate')).map((c) => c.params.db), ['one', 'two']);
    const mutations = calls.filter((c) => c.route.endsWith('call_button'));
    assert.equal(mutations.length, 3);
    assert.deepEqual(mutations[0].params.args, [[42]]);
    assert.equal(mutations[0].params.method, 'button_immediate_upgrade');
    assert.equal(mutations[0].cookie, 'session_id=fake');
});

for (const behavior of [{ drop: true }, { timeout: true }, { invalid: true }]) {
    test(`ambiguous mutation is not retried: ${JSON.stringify(behavior)}`, async (t) => {
        const { profile, calls } = await fixture(t, behavior);
        await assert.rejects(new OdooRpc({ timeout: 100 }).upgrade(profile, 'db', 'demo', async () => 'secret'),
            (error) => error.uncertain === true);
        assert.equal(calls.filter((c) => c.route.endsWith('call_button')).length, 1);
    });
}

test('Odoo application error is surfaced without automatic retries', async (t) => {
    const { profile, calls } = await fixture(t, { error: true });
    await assert.rejects(new OdooRpc().upgrade(profile, 'db', 'demo', async () => 'secret'),
        (error) => error.message === 'Invalid XML' && !error.uncertain);
    assert.equal(calls.length, 3);
});

for (const behavior of [{ badLogin: true }, { missing: true }]) {
    test(`preflight prevents mutation: ${JSON.stringify(behavior)}`, async (t) => {
        const { profile, calls } = await fixture(t, behavior);
        await assert.rejects(new OdooRpc().upgrade(profile, 'db', 'demo', async () => 'secret'));
        assert.equal(calls.filter((c) => c.route.endsWith('call_button')).length, 0);
    });
}
