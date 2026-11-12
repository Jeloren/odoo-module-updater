import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('catalog', Path(__file__).parents[1] / 'src/catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class CatalogTests(unittest.TestCase):
    def test_paths_precedence_and_missing_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, label in (('a/sale', 'First'), ('b/sale', 'Second'), ('a/base', 'Base')):
                addon = root / name
                addon.mkdir(parents=True)
                (addon / '__manifest__.py').write_text(repr({'name': label, 'depends': ['base'], 'data': ['views/form.xml', 'security/access.csv']}))
            modules = catalog.discover([root / 'missing', root / 'a', root / 'b'])
            self.assertEqual(modules['sale']['title'], 'First')
            self.assertEqual(modules['sale']['kind'], 'core')
            self.assertEqual(modules['sale']['dataFiles'], ['views/form.xml', 'security/access.csv'])

    def test_downstream_includes_installed_transitive_children_and_handles_cycle(self):
        modules = {
            'root': {'state': 'installed', 'depends': ['grandchild']},
            'child': {'state': 'installed', 'depends': ['root']},
            'grandchild': {'state': 'installed', 'depends': ['child']},
            'uninstalled': {'state': 'uninstalled', 'depends': ['root']},
            'unrelated': {'state': 'installed', 'depends': []},
        }
        self.assertEqual(catalog.downstream(modules, 'root'), ['root', 'child', 'grandchild'])

    def test_base_includes_all_installed_except_studio_customization(self):
        modules = {name: {'state': 'installed', 'depends': []}
                   for name in ('base', 'sale', 'studio_customization')}
        self.assertEqual(catalog.downstream(modules, 'base'), ['base', 'sale'])


if __name__ == '__main__':
    unittest.main()
