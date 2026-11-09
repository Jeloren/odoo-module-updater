const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { loadProfiles, catalogCommand, runtimeKey, runUpgrade } = require('./core');

const installedStates = new Set(['installed', 'to upgrade']);

function settingsFiles() {
    const found = new Map();
    for (const folder of vscode.workspace.workspaceFolders || []) {
        let directory = folder.uri.fsPath;
        for (;;) {
            const file = path.join(directory, '.vscode', 'odoo-update.json');
            if (fs.existsSync(file)) {
                found.set(file, directory);
                break;
            }
            const parent = path.dirname(directory);
            if (parent === directory) break;
            directory = parent;
        }
    }
    return found;
}

function activate(context) {
    const output = vscode.window.createOutputChannel('Odoo Module Updater');
    const script = fs.readFileSync(context.asAbsolutePath('src/catalog.py'), 'utf8');
    const updateButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 22);
    const moduleButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 21);
    const databaseButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    const changed = new vscode.EventEmitter();
    let profile;
    let target = {};
    let modules = [];
    let busy = false;
    let disposed = false;

    function stateKey(current = profile) {
        return `odooUpdate.target.${current.settingsFile}.${current.id}.${runtimeKey(current)}`;
    }

    function refreshButtons() {
        updateButton.text = busy ? '$(sync~spin) Odoo' : '$(sync) Обновить модуль';
        updateButton.tooltip = target.module ? `${profile?.label || profile?.id} / ${target.database} / ${target.module}` : 'Выбрать модуль Odoo';
        moduleButton.text = `$(chevron-down) ${target.module || 'Модуль Odoo'}`;
        moduleButton.tooltip = 'Выбрать модуль из addons_path';
        databaseButton.text = `$(database) ${target.database || 'База Odoo'}`;
        databaseButton.tooltip = `${profile?.label || profile?.id || 'Окружение Odoo'} — выбрать базу`;
        for (const item of [updateButton, moduleButton, databaseButton]) {
            if (profile) item.show(); else item.hide();
        }
        changed.fire();
    }

    async function saveTarget(next) {
        await context.workspaceState.update(stateKey(), next);
        target = next;
        refreshButtons();
    }

    function availableProfiles() {
        return [...settingsFiles()].flatMap(([file, workspace]) => loadProfiles(file, workspace));
    }

    async function useProfile(next) {
        profile = next;
        target = context.workspaceState.get(stateKey(), {});
        if (profile.database && !target.database) target = { database: profile.database };
        modules = [];
        await context.workspaceState.update('odooUpdate.profile', { file: next.settingsFile, id: next.id });
        refreshButtons();
    }

    async function chooseProfile() {
        const profiles = availableProfiles();
        if (!profiles.length) {
            await configure();
            return false;
        }
        const item = await vscode.window.showQuickPick(profiles.map((value) => ({
            label: value.label || value.id, description: value.type, detail: value.settingsFile, value,
        })), { title: 'Окружение Odoo 17' });
        if (!item) return false;
        await useProfile(item.value);
        return true;
    }

    async function ensureProfile() {
        if (!vscode.workspace.isTrusted) throw new Error('Для запуска команд нужен доверенный workspace VS Code.');
        const profiles = availableProfiles();
        const current = profile && profiles.find((item) => item.settingsFile === profile.settingsFile && item.id === profile.id);
        if (current) {
            if (JSON.stringify(current) !== JSON.stringify(profile)) await useProfile(current);
            return true;
        }
        if (profiles.length === 1) {
            await useProfile(profiles[0]);
            return true;
        }
        return chooseProfile();
    }

    function run(command, stream = false, timeout = 0) {
        return new Promise((resolve, reject) => {
            const child = spawn(command.command, command.args, { cwd: command.cwd || profile.cwd, windowsHide: true });
            let stdout = '';
            let stderr = '';
            let timer;
            let failure;
            if (timeout) timer = setTimeout(() => {
                failure = new Error('Команда чтения данных Odoo превысила время ожидания.');
                child.kill();
            }, timeout);
            child.stdout.setEncoding('utf8').on('data', (chunk) => {
                if (stream) output.append(chunk); else stdout += chunk;
            });
            child.stderr.setEncoding('utf8').on('data', (chunk) => {
                if (stream) output.append(chunk); else stderr = (stderr + chunk).slice(-65536);
            });
            child.on('error', (error) => { clearTimeout(timer); reject(error); });
            child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') failure = error; });
            child.on('close', (code) => {
                clearTimeout(timer);
                if (failure) return reject(failure);
                if (code === 0) return resolve(stdout);
                try {
                    const response = JSON.parse(stdout);
                    if (response.error) return reject(new Error(response.error));
                } catch { /* Odoo startup errors are shown in the output channel. */ }
                if (stderr) output.appendLine(stderr);
                reject(new Error(`${path.basename(command.command)} завершился с кодом ${code}. Подробности в Output.`));
            });
            child.stdin.end(command.input);
        });
    }

    async function catalog(mode, extra = {}) {
        const response = JSON.parse(await run(catalogCommand(profile, script,
            { mode, database: target.database, ...extra }), false, 60000));
        if (!response.ok) throw new Error(response.error);
        return response.result;
    }

    async function chooseDatabase() {
        if (!await ensureProfile()) return false;
        const result = await catalog('databases', { database: undefined });
        const database = await vscode.window.showQuickPick(result.databases, { title: `База Odoo — ${profile.label || profile.id}` });
        if (!database) return false;
        if (database !== target.database) {
            await saveTarget({ database });
            modules = [];
        }
        return true;
    }

    async function readModules() {
        if (!await ensureProfile() || (!target.database && !await chooseDatabase())) return false;
        const result = await catalog('modules');
        modules = result.modules;
        if (target.module && !modules.some((item) => item.name === target.module && installedStates.has(item.state))) {
            await saveTarget({ database: target.database });
        }
        changed.fire();
        return true;
    }

    async function chooseModule(item) {
        if (!await readModules()) return false;
        if (item?.module) {
            const value = modules.find((value) => value.name === item.module.name);
            if (!value || !installedStates.has(value.state) || !value.available || !value.installable) {
                throw new Error('Для обновления нужен установленный модуль с доступным manifest.');
            }
            await saveTarget({ database: target.database, module: value.name });
            return true;
        }
        const selected = await vscode.window.showQuickPick(modules.filter((value) => installedStates.has(value.state) && value.available && value.installable)
            .map((value) => ({ label: value.name, description: value.title, detail: `${value.kind} · ${value.path}`, value })), {
                title: `Выберите модуль — ${target.database}`, matchOnDescription: true, matchOnDetail: true,
            });
        if (!selected) return false;
        await saveTarget({ database: target.database, module: selected.value.name });
        return true;
    }

    async function plan() {
        if (!await readModules()) return;
        if (!target.module && !await chooseModule()) return;
        const result = await catalog('plan', { module: target.module });
        const unavailable = result.plan.filter((item) => !item.available || !item.installable);
        if (unavailable.length) throw new Error(`Недоступны исходники: ${unavailable.map((item) => item.name).join(', ')}.`);
        return result.plan;
    }

    async function preview() {
        const items = await plan();
        if (!items) return;
        output.show(true);
        output.appendLine(`\n${target.database} / ${target.module}: ${items.length} модулей`);
        for (const item of items) output.appendLine(`  ${item.name} — ${item.path}`);
        await vscode.window.showQuickPick(items.map((item) => ({ label: item.name, description: item.title, detail: item.path })), {
            title: 'План обновления, рассчитанный по текущим manifest', placeHolder: 'Просмотр списка. Обновление запускается отдельной кнопкой.',
        });
    }

    async function update() {
        const remembered = target.module;
        if (!await readModules()) return;
        if (remembered && !target.module) {
            vscode.window.showWarningMessage(`Модуль ${remembered} больше не установлен. Выбор сброшен.`);
            return;
        }
        if (!target.module && !await chooseModule()) return;
        const selectedPlan = await catalog('plan', { module: target.module });
        if (selectedPlan.plan.some((item) => !item.available || !item.installable)) {
            throw new Error('В плане есть недоступные исходники. Откройте «Показать план обновления».');
        }
        await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
        const lock = path.join(context.globalStorageUri.fsPath, `${runtimeKey(profile)}.lock`);
        let handle;
        try { handle = await fs.promises.open(lock, 'wx'); }
        catch (error) {
            if (error.code === 'EEXIST') throw new Error(`Обновление этого окружения уже запущено. Блокировка: ${lock}`);
            throw error;
        }
        try {
            await handle.writeFile(JSON.stringify({ pid: process.pid, date: new Date().toISOString(), database: target.database, module: target.module }));
            output.show(true);
            output.appendLine(`\n[${new Date().toLocaleString()}] ${profile.label || profile.id} / ${target.database}`);
            output.appendLine(`Модули: ${selectedPlan.plan.map((item) => item.name).join(', ')}`);
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                title: `Odoo: обновление ${target.module}`, cancellable: false },
            () => runUpgrade(profile, target.database, target.module, run));
            vscode.window.showInformationMessage(`Odoo: ${target.module} обновлён в ${target.database}.`);
            modules = [];
        } finally {
            await handle.close();
            await fs.promises.unlink(lock);
        }
    }

    async function configure() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) throw new Error('Откройте рабочую папку VS Code.');
        const existing = [...settingsFiles().keys()][0];
        let file = existing;
        if (!file) {
            const mode = await vscode.window.showQuickPick(['docker', 'local'], { title: 'Как запускается Odoo?' });
            if (!mode) return;
            file = path.join(folder.uri.fsPath, '.vscode', 'odoo-update.json');
            await fs.promises.mkdir(path.dirname(file), { recursive: true });
            await fs.promises.copyFile(context.asAbsolutePath(`examples/${mode}.json`), file, fs.constants.COPYFILE_EXCL);
        }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    }

    const provider = {
        onDidChangeTreeData: changed.event,
        getChildren: () => modules,
        getTreeItem(value) {
            const item = new vscode.TreeItem(value.name);
            item.description = `${value.state} · ${value.kind}`;
            item.tooltip = `${value.title}\n${value.path || 'Исходники отсутствуют'}${value.error ? '\n' + value.error : ''}`;
            item.iconPath = new vscode.ThemeIcon(value.available ? 'package' : 'warning');
            item.contextValue = 'odooModule';
            item.command = { command: 'odooUpdate.chooseModule', title: 'Выбрать модуль', arguments: [{ module: value }] };
            return item;
        },
    };

    function command(id, callback) {
        return vscode.commands.registerCommand(id, async (...args) => {
            if (busy || disposed) return;
            busy = true;
            refreshButtons();
            try { await callback(...args); }
            catch (error) {
                output.appendLine(error.message);
                output.show(true);
                vscode.window.showErrorMessage(`Odoo: ${error.message}`);
            } finally { busy = false; refreshButtons(); }
        });
    }

    const actions = { chooseModule, chooseDatabase, chooseProfile, update, preview, configure, refresh: readModules };
    context.subscriptions.push(output, changed, updateButton, moduleButton, databaseButton,
        vscode.window.registerTreeDataProvider('odooUpdate.modules', provider));
    for (const [name, action] of Object.entries(actions)) context.subscriptions.push(command(`odooUpdate.${name}`, action));
    for (const name of ['chooseModule', 'chooseDatabase', 'update']) {
        context.subscriptions.push(command(`afsOdooUpdate.${name}`, actions[name]));
    }
    context.subscriptions.push({ dispose() { disposed = true; } });
    updateButton.command = 'odooUpdate.update';
    moduleButton.command = 'odooUpdate.chooseModule';
    databaseButton.command = 'odooUpdate.chooseDatabase';
    try {
        const profiles = availableProfiles();
        const remembered = context.workspaceState.get('odooUpdate.profile');
        const initial = profiles.find((item) => item.id === remembered?.id && item.settingsFile === remembered?.file) || profiles[0];
        if (initial) useProfile(initial).catch((error) => output.appendLine(error.message));
    } catch (error) { output.appendLine(error.message); }
}

module.exports = { activate };
