import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('studio_dev', Path(__file__).with_name('studio-dev.py'))
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)

class DevLauncherTests(unittest.TestCase):
    def test_forbids_source_and_installed_app_overlap(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for state in (root/'repo', root/'repo/cache', root/'base/inside', root):
                with self.assertRaises(ValueError): dev.validate_paths(root/'repo', root/'base', state)

    def test_requires_owned_state_and_rejects_other_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); state = root/'state'; state.mkdir(); (state/'keep').write_text('do not overwrite')
            with self.assertRaises(ValueError): dev.validate_paths(root/'repo', root/'base', state)
            (state/'owner.json').write_text(json.dumps({'format':dev.FORMAT,'repo':str((root/'repo').resolve())}))
            dev.validate_paths(root/'repo',root/'base',state)
            with self.assertRaises(ValueError): dev.validate_paths(root/'other',root/'base',state)

    def test_helper_names_preserved_while_identity_isolated(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp)/'dev.app'; root = app/'Contents/Resources/app'; root.mkdir(parents=True)
            (root/'product.json').write_text(json.dumps({'nameShort':'HypeProof Studio','updateUrl':'https://example.com'}))
            (root/'package.json').write_text('{"name":"HypeProof Studio"}')
            info = app/'Contents/Info.plist';info.write_bytes(plistlib.dumps({'CFBundleName':'HypeProof Studio','CFBundleExecutable':'HypeProof Studio','CFBundleIdentifier':'ai.hypeproof.studio','CFBundleURLTypes':[]}))
            dev.configure_copy(app,'test')
            actual = plistlib.loads(info.read_bytes())
            self.assertEqual(actual['CFBundleName'],'HypeProof Studio')
            self.assertEqual(actual['CFBundleExecutable'],'HypeProof Studio')
            self.assertNotEqual(actual['CFBundleIdentifier'],'ai.hypeproof.studio')
            self.assertNotIn('CFBundleURLTypes',actual)
            self.assertEqual(json.loads((root/'package.json').read_text())['name'],'HypeProof Studio')
            self.assertNotIn('updateUrl',json.loads((root/'product.json').read_text()))

    def test_process_inspection_fails_closed(self):
        for code,expected in [(0,True),(1,False)]:
            with patch.object(dev.subprocess,'run',return_value=subprocess.CompletedProcess([],code)):
                self.assertEqual(dev.app_running(Path('/tmp/test.app')),expected)
        with patch.object(dev.subprocess,'run',return_value=subprocess.CompletedProcess([],3)):
            with self.assertRaises(RuntimeError): dev.app_running(Path('/tmp/test.app'))

    def test_local_default_and_preserve_user_settings(self):
        source={'editor.fontSize':20,'workbench.colorCustomizations':{'editor.background':'#111111'}}
        result=dev.settings_for(source,'local','test')
        self.assertEqual(result['editor.fontSize'],20)
        self.assertEqual(result['workbench.colorCustomizations']['editor.background'],'#111111')
        self.assertEqual(result['hypeproofChat.proxyUrl'],'http://127.0.0.1:8787/v1')
        self.assertEqual(result['update.mode'],'none')
        self.assertNotIn('window.title',source)

    def test_file_manifest_detects_payload_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'binary').write_bytes(b'old');before=dev.file_manifest(root)
            (root/'binary').write_bytes(b'new');self.assertNotEqual(before,dev.file_manifest(root))

    def test_running_app_is_not_modified_or_built(self):
        with patch.object(dev,'app_running',return_value=True),patch.object(dev,'build') as build:
            with self.assertRaises(RuntimeError): dev.prepare(Path('/repo'),Path('/base'),Path('/state'),'local')
            build.assert_not_called()

    def test_early_exit_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            state=Path(tmp);app=state/'dev.app';(app/'Contents').mkdir(parents=True)
            (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'HypeProof Studio'}))
            with patch.object(dev.subprocess,'Popen') as popen,patch.object(dev.time,'sleep'):
                popen.return_value.poll.return_value=1
                with self.assertRaises(RuntimeError): dev.launch(app,state)
                self.assertEqual(popen.call_args.kwargs['env']['HPS_DEV_TOKEN_FILE'],str(state/'local-participant-token.txt'))
                self.assertTrue(any('--user-data-dir=' in s for s in popen.call_args.args[0]))

if __name__=='__main__': unittest.main()
