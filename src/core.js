const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function resolveHostPath(value, workspace) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Путь должен быть непустой строкой.');
    return path.resolve(workspace, value.replaceAll('${workspaceFolder}', workspace));
}

function validateCommand(command, name) {
    if (!command || typeof command.command !== 'string' || !command.command.trim() ||
        !Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string')) {
        throw new Error(`${name}: нужны command и массив строк args.`);
    }
}

function loadProfiles(file, workspace) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (data.version !== 1 || !data.profiles || Array.isArray(data.profiles) || typeof data.profiles !== 'object') {
        throw new Error('В odoo-update.json нужны version: 1 и объект profiles.');
    }
    return Object.entries(data.profiles).map(([id, entry]) => {
        const profile = { ...entry, id, workspace, settingsFile: file };
        if (!['docker', 'local'].includes(profile.type)) throw new Error(`${id}: type должен быть docker или local.`);
        for (const key of ['python', 'odooBin', 'config']) {
            if (typeof profile[key] !== 'string' || !profile[key].trim()) throw new Error(`${id}: укажите ${key}.`);
        }
        profile.cwd = resolveHostPath(profile.cwd || '.', workspace);
        if (profile.type === 'docker') {
            if (!Array.isArray(profile.composeFiles) || !profile.composeFiles.length ||
                typeof profile.service !== 'string' || !profile.service.trim()) {
                throw new Error(`${id}: укажите composeFiles и service.`);
            }
            profile.composeFiles = profile.composeFiles.map((item) => resolveHostPath(item, workspace));
        } else {
            for (const key of ['config', 'odooBin']) profile[key] = resolveHostPath(profile[key], workspace);
            if (profile.python.includes('/') || profile.python.includes('\\')) profile.python = resolveHostPath(profile.python, workspace);
            if (Boolean(profile.stopCommand) !== Boolean(profile.startCommand)) throw new Error(`${id}: stopCommand и startCommand задаются вместе.`);
            if (profile.stopCommand) {
                validateCommand(profile.stopCommand, 'stopCommand');
                validateCommand(profile.startCommand, 'startCommand');
                for (const name of ['stopCommand', 'startCommand']) {
                    const hook = profile[name];
                    profile[name] = {
                        command: hook.command.replaceAll('${workspaceFolder}', workspace),
                        args: hook.args.map((arg) => arg.replaceAll('${workspaceFolder}', workspace)),
                        cwd: resolveHostPath(hook.cwd || profile.cwd, workspace),
                    };
                }
            }
        }
        if (profile.addonsPath !== undefined &&
            (!Array.isArray(profile.addonsPath) || profile.addonsPath.some((item) => typeof item !== 'string'))) {
            throw new Error(`${id}: addonsPath должен быть массивом путей среды Odoo.`);
        }
        if (profile.database !== undefined && typeof profile.database !== 'string') throw new Error(`${id}: database должна быть строкой.`);
        return profile;
    });
}

function composeArgs(profile, args) {
    return ['compose', ...profile.composeFiles.flatMap((file) => ['-f', file]), ...args];
}

function catalogCommand(profile, script, request) {
    const input = JSON.stringify({ ...request, config: profile.config, odooBin: profile.odooBin, addonsPath: profile.addonsPath });
    if (profile.type === 'docker') {
        return { command: 'docker', args: composeArgs(profile,
            ['run', '--rm', '--no-deps', '-T', '--entrypoint', profile.python, profile.service, '-c', script]), input };
    }
    return { command: profile.python, args: ['-c', script], input };
}

function upgradeCommand(profile, database, module) {
    if (!database || typeof database !== 'string') throw new Error('Не выбрана база данных.');
    if (!/^[a-zA-Z0-9_]+$/.test(module) || module === 'all') throw new Error('Недопустимое имя модуля.');
    const args = [profile.odooBin, '-c', profile.config, '-d', database, '-u', module,
        '--stop-after-init', '--no-http', '--max-cron-threads=0'];
    if (profile.addonsPath?.length) args.push('--addons-path', profile.addonsPath.join(','));
    if (profile.type === 'docker') {
        return { command: 'docker', args: composeArgs(profile,
            ['run', '--rm', '--no-deps', '-T', '--entrypoint', profile.python, profile.service, ...args]) };
    }
    if (!profile.stopCommand && profile.serverAlreadyStopped !== true) {
        throw new Error('Локальный профиль: задайте stopCommand/startCommand или serverAlreadyStopped: true для остановленного сервера.');
    }
    return { command: profile.python, args };
}

function runtimeKey(profile) {
    const identity = profile.type === 'docker'
        ? [profile.type, profile.composeFiles, profile.service]
        : [profile.type, profile.python, profile.config];
    return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
}

async function runUpgrade(profile, database, module, run) {
    const upgrade = upgradeCommand(profile, database, module);
    let restart = false;
    let failure;
    try {
        if (profile.type === 'docker') {
            const running = await run({ command: 'docker', args: composeArgs(profile,
                ['ps', '--status', 'running', '-q', profile.service]) });
            restart = Boolean(running.trim());
            if (restart) await run({ command: 'docker', args: composeArgs(profile, ['stop', profile.service]) }, true);
        } else if (profile.stopCommand) {
            restart = true;
            await run(profile.stopCommand, true);
        }
        await run(upgrade, true);
    } catch (error) {
        failure = error;
    } finally {
        if (restart) {
            const start = profile.type === 'docker'
                ? { command: 'docker', args: composeArgs(profile, ['start', profile.service]) }
                : profile.startCommand;
            try { await run(start, true); }
            catch (error) { failure = new Error(`${failure ? failure.message + '\n' : ''}Не удалось запустить сервер: ${error.message}`); }
        }
    }
    if (failure) throw failure;
}

module.exports = { loadProfiles, composeArgs, catalogCommand, upgradeCommand, runtimeKey, runUpgrade };
