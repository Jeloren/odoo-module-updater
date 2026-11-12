const fs = require('node:fs');
const path = require('node:path');

function locateLayoutTarget(file, modules) {
    if (path.extname(file).toLowerCase() !== '.xml') throw new Error('Откройте XML-файл из data в manifest модуля.');
    const realFile = fs.realpathSync(file);
    let root = path.dirname(realFile);
    while (!fs.existsSync(path.join(root, '__manifest__.py'))) {
        const parent = path.dirname(root);
        if (parent === root) throw new Error('Рядом с файлом не найден __manifest__.py.');
        root = parent;
    }
    const addon = modules.find((item) => item.name === path.basename(root));
    if (!addon?.available || !addon.installable || !['installed', 'to upgrade'].includes(addon.state)) {
        throw new Error('Модуль файла должен быть установлен в выбранной базе.');
    }
    // Never silently bind a duplicate checkout to the module loaded by Odoo.
    if (!fs.existsSync(addon.path) || fs.realpathSync(addon.path) !== root) {
        throw new Error('Путь модуля в Odoo отличается от открытого файла. Откройте исходники в среде Odoo (для Docker — Dev Container).');
    }
    const files = new Set((addon.dataFiles || []).filter((name) => typeof name === 'string' && path.extname(name).toLowerCase() === '.xml')
        .map((name) => path.resolve(root, name)).filter((name) => name.startsWith(root + path.sep) && fs.existsSync(name))
        .map((name) => fs.realpathSync(name)).filter((name) => name.startsWith(root + path.sep)));
    if (!files.has(realFile)) throw new Error('Файл не указан в data manifest. Статические assets автоматически не обновляются.');
    return { module: addon.name, root, files };
}

class LayoutQueue {
    constructor(execute, { delay = 800, onError = () => {}, onChange = () => {} } = {}) {
        this.execute = execute;
        this.delay = delay;
        this.onError = onError;
        this.onChange = onChange;
        this.running = false;
        this.enabled = false;
        this.generation = 0;
    }
    enable(target) {
        this.disable();
        this.target = target;
        this.enabled = true;
        this.onChange();
    }
    disable() {
        this.enabled = false;
        this.generation++;
        this.pending = false;
        clearTimeout(this.timer);
        this.onChange();
    }
    saved(file) {
        if (!this.enabled) return;
        if (path.resolve(file) === path.join(this.target.root, '__manifest__.py')) {
            this.disable();
            this.onError(new Error('Manifest изменён. Включите режим вёрстки заново для перечитывания data.'));
            return;
        }
        let real;
        try { real = fs.realpathSync(file); } catch { return; }
        if (!this.target.files.has(real)) return;
        this.pending = true;
        this.due = Date.now() + this.delay;
        this.arm();
    }
    arm() {
        clearTimeout(this.timer);
        if (!this.enabled || !this.pending || this.running) return;
        this.timer = setTimeout(() => this.flush(), Math.max(0, this.due - Date.now()));
    }
    async flush() {
        if (!this.enabled || !this.pending || this.running) return;
        const generation = this.generation;
        const target = this.target;
        this.pending = false;
        this.running = true;
        try {
            const completed = await this.execute(target);
            if (completed === false && generation === this.generation) {
                this.pending = true;
                this.due = Date.now() + this.delay;
            }
        } catch (error) {
            if (generation === this.generation) this.disable();
            this.onError(error);
        } finally {
            this.running = false;
            this.arm();
        }
    }
}

module.exports = { LayoutQueue, locateLayoutTarget };
