"""Read-only Odoo 17 metadata. Request and result use JSON over stdin/stdout."""
import ast
import contextlib
import json
from pathlib import Path
import re
import sys


def discover(paths):
    modules = {}
    for directory in paths:
        directory = Path(directory)
        if not directory.is_dir():
            continue
        core = any((directory / name / '__manifest__.py').is_file() for name in ('base', 'web', 'web_enterprise'))
        for addon in sorted(directory.iterdir()):
            if addon.name in modules or not re.fullmatch(r'[a-zA-Z0-9_]+', addon.name):
                continue
            manifest = next((addon / name for name in ('__manifest__.py', '__openerp__.py')
                             if (addon / name).is_file()), None)
            if manifest is None:
                continue
            item = {'name': addon.name, 'path': str(addon), 'addonsPath': str(directory),
                    'kind': 'core' if core else 'extra', 'available': True}
            try:
                data = ast.literal_eval(manifest.read_text(encoding='utf-8-sig'))
                item.update(title=str(data.get('name', addon.name)),
                            depends=data.get('depends', []), installable=data.get('installable', True),
                            dataFiles=data.get('data', []) if isinstance(data.get('data', []), (list, tuple)) else [])
            except (OSError, ValueError, SyntaxError, AttributeError):
                item.update(title=addon.name, depends=[], installable=False, error='Не удалось прочитать manifest')
            modules[addon.name] = item
    return modules


def downstream(modules, root):
    selected = {root}
    pending = [root]
    while pending:
        dependency = pending.pop()
        for name, module in modules.items():
            if name not in selected and module.get('state') in ('installed', 'to upgrade') and (
                dependency in module.get('depends', []) or root == 'base'
            ) and name != 'studio_customization':
                selected.add(name)
                pending.append(name)
    return [root] + sorted(selected - {root})


def collect(request):
    import psycopg2

    server = Path(request['odooBin']).expanduser().parent
    if (server / 'odoo').is_dir():
        sys.path.insert(0, str(server))
    with contextlib.redirect_stdout(sys.stderr):
        import odoo
        from odoo import release
        from odoo.tools import config
        from odoo.modules import module as module_tools

        if release.version_info[0] != 17:
            raise ValueError('Это расширение поддерживает Odoo 17.')
        args = ['-c', request['config']]
        if request.get('addonsPath'):
            args += ['--addons-path', ','.join(request['addonsPath'])]
        config.parse_config(args)
        module_tools.initialize_sys_path()
        paths = list(odoo.addons.__path__)

    params = {name: config[f'db_{name}'] for name in ('host', 'port', 'user', 'password', 'sslmode')
              if config[f'db_{name}'] not in (None, False, '')}
    mode = request.get('mode', 'modules')
    database = request.get('database')
    with psycopg2.connect(dbname=database or 'postgres', connect_timeout=10, **params) as connection:
        connection.set_session(readonly=True, autocommit=True)
        with connection.cursor() as cursor:
            if mode == 'databases':
                cursor.execute("""SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate
                    AND datname <> 'postgres' AND has_database_privilege(datname, 'CONNECT') ORDER BY datname""")
                databases = [row[0] for row in cursor]
                pattern = config['dbfilter']
                if pattern and '%h' not in pattern and '%d' not in pattern:
                    databases = [name for name in databases if re.match(pattern, name)]
                return {'databases': databases}
            if not database:
                raise ValueError('Не выбрана база данных.')
            cursor.execute('SELECT name, state FROM ir_module_module ORDER BY name')
            states = dict(cursor.fetchall())
            cursor.execute('SELECT m.name, d.name FROM ir_module_module_dependency d JOIN ir_module_module m ON m.id=d.module_id')
            stored_dependencies = {}
            for name, dependency in cursor:
                stored_dependencies.setdefault(name, []).append(dependency)

    modules = discover(paths)
    for name, state in states.items():
        if name not in modules and state in ('installed', 'to upgrade', 'to remove'):
            modules[name] = {'name': name, 'title': name, 'path': '', 'addonsPath': '', 'kind': 'missing',
                             'available': False, 'depends': stored_dependencies.get(name, []), 'installable': False}
    for name, item in modules.items():
        item['state'] = states.get(name, 'uninstalled')
        if not isinstance(item.get('depends'), (list, tuple)):
            item.update(depends=[], installable=False, error='Некорректный список depends')
    result = {'version': release.version, 'addonsPaths': paths, 'modules': sorted(modules.values(), key=lambda item: item['name'])}
    if mode == 'plan':
        root = request.get('module')
        if root not in modules or modules[root]['state'] not in ('installed', 'to upgrade'):
            raise ValueError('Выбранный модуль больше не установлен.')
        result['plan'] = [modules[name] for name in downstream(modules, root)]
    return result


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8')
    try:
        print(json.dumps({'ok': True, 'result': collect(json.load(sys.stdin))}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
