"""Build a source archive from an explicit list of distributable files."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import json

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
destination = root / 'dist'
destination.mkdir(exist_ok=True)
files = ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'CHANGELOG.md', '.gitignore', '.vscodeignore']
for directory in ('src', 'schemas', 'examples', 'scripts', 'test', 'docs', '.github'):
    files.extend(str(file.relative_to(root)) for file in (root / directory).rglob('*')
                 if file.is_file() and '__pycache__' not in file.parts and file.suffix != '.pyc')
with ZipFile(destination / f'odoo-module-updater-{version}-source.zip', 'w', ZIP_DEFLATED) as archive:
    for name in sorted(files):
        archive.write(root / name, f'odoo-module-updater/{Path(name).as_posix()}')
print('Source archive created')
