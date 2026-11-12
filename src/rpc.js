const http = require('node:http');
const https = require('node:https');

class RpcError extends Error {
    constructor(message, { uncertain = false, authentication = false } = {}) {
        super(message);
        this.uncertain = uncertain;
        this.authentication = authentication;
    }
}

function connectionKey(profile, database) {
    return JSON.stringify([new URL(profile.serverUrl).href.replace(/\/$/, ''), database, profile.login]);
}

class OdooRpc {
    constructor({ timeout = 120000 } = {}) {
        this.timeout = timeout;
        this.sessions = new Map();
    }

    async request(profile, route, params, cookie = '', mutation = false) {
        const url = new URL(profile.serverUrl.replace(/\/$/, '') + route);
        const body = JSON.stringify({ jsonrpc: '2.0', method: 'call', params, id: 1 });
        return new Promise((resolve, reject) => {
            let sent = false;
            let done = false;
            let timer;
            const fail = (message) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                reject(new RpcError(message, { uncertain: mutation && sent }));
            };
            const req = (url.protocol === 'https:' ? https : http).request(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body), ...(cookie ? { Cookie: cookie } : {}) },
            }, (res) => {
                let text = '';
                let bytes = 0;
                res.setEncoding('utf8');
                res.on('data', (part) => {
                    bytes += Buffer.byteLength(part);
                    if (bytes > 8 * 1024 * 1024) {
                        fail('Ответ Odoo превышает допустимый размер.'); req.destroy(); return;
                    }
                    text += part;
                });
                res.on('aborted', () => fail('Соединение с Odoo прервано.'));
                res.on('error', () => fail('Ошибка чтения ответа Odoo.'));
                res.on('end', () => {
                    if (done) return;
                    if (res.statusCode !== 200) {
                        fail(`Odoo вернул HTTP ${res.statusCode}. Перенаправления не выполняются.`); return;
                    }
                    let response;
                    try { response = JSON.parse(text); }
                    catch { fail('Odoo вернул некорректный JSON.'); return; }
                    if (!response || response.id !== 1 || (!('result' in response) && !response.error)) {
                        fail('Неожиданный ответ Odoo.'); return;
                    }
                    done = true;
                    clearTimeout(timer);
                    if (response.error) {
                        const data = response.error.data || {};
                        reject(new RpcError(data.message || response.error.message || 'Ошибка Odoo.', {
                            authentication: /AccessDenied|SessionExpired/.test(data.name || ''),
                        }));
                    } else {
                        const cookies = res.headers['set-cookie'] || [];
                        resolve({ result: response.result,
                            cookie: cookies.map((value) => value.split(';')[0]).find((value) => value.startsWith('session_id=')) || cookie });
                    }
                });
            });
            req.on('finish', () => { sent = true; });
            req.on('error', (error) => fail(`Нет связи с Odoo (${error.code || 'network error'}).`));
            timer = setTimeout(() => { fail('Истекло время ожидания Odoo.'); req.destroy(); }, this.timeout);
            req.end(body);
        });
    }

    forget(profile, database) { this.sessions.delete(connectionKey(profile, database)); }

    async authenticate(profile, database, getPassword) {
        const key = connectionKey(profile, database);
        if (this.sessions.has(key)) return this.sessions.get(key);
        const password = await getPassword();
        if (password === undefined) throw new RpcError('Ввод пароля отменён.');
        const response = await this.request(profile, '/web/session/authenticate', {
            db: database, login: profile.login, password,
        });
        if (!response.result?.uid || !response.cookie) {
            throw new RpcError('Вход не выполнен. Проверьте логин, пароль и требования двухфакторной аутентификации.', { authentication: true });
        }
        if (response.result.server_version_info?.[0] !== 17) throw new RpcError('RPC-режим поддерживает Odoo 17.');
        if (response.result.db && response.result.db !== database) throw new RpcError('Сервер выбрал другую базу данных.');
        this.sessions.set(key, response.cookie);
        return response.cookie;
    }

    async upgrade(profile, database, module, getPassword) {
        if (!database || !/^[a-zA-Z0-9_]+$/.test(module) || module === 'all') throw new RpcError('Некорректная цель обновления.');
        try {
            const cookie = await this.authenticate(profile, database, getPassword);
            const found = await this.request(profile, '/web/dataset/call_kw', {
                model: 'ir.module.module', method: 'search_read',
                args: [[['name', '=', module], ['state', 'in', ['installed', 'to upgrade']]]],
                kwargs: { fields: ['id', 'name'], limit: 2 },
            }, cookie);
            if (!Array.isArray(found.result) || found.result.length !== 1) throw new RpcError('Модуль не установлен в выбранной базе.');
            await this.request(profile, '/web/dataset/call_button', {
                model: 'ir.module.module', method: 'button_immediate_upgrade',
                args: [[found.result[0].id]], kwargs: {},
            }, cookie, true);
        } catch (error) {
            if (error.authentication) this.forget(profile, database);
            throw error;
        }
    }
}

module.exports = { OdooRpc, RpcError, connectionKey };
