import importlib.util
import io
import json
import os
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
    def test_local_setup_preserves_active_session_and_validates_before_saving(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)/'repo'; state = Path(tmp)/'state'; state.mkdir()
            (repo/'worker').mkdir(parents=True)
            (repo/'worker/.dev.vars').write_text('HPS_ADMIN_PASSWORD=synthetic-password', encoding='utf-8')
            calls = []
            def fetch(req, timeout):
                calls.append((req.method, req.full_url.removeprefix('http://127.0.0.1:8787')))
                bodies = {
                    '/v1/health': {'service':'hypeproof-studio-api','env':'dev'},
                    '/admin/cohorts/homepage-practice': {'session':{'profile_id':'homepage-practice-s1','ends_at':'2099-01-01T00:00:00Z'}},
                    '/admin/tokens/issue': {'token':'synthetic-participant'},
                }
                return io.BytesIO(json.dumps(bodies.get(calls[-1][1], {})).encode())
            with patch.dict(os.environ, {}, clear=True), patch.object(dev,'urlopen',side_effect=fetch), patch('builtins.print'):
                dev.setup_local_participant(repo, state)
            self.assertNotIn(('POST','/admin/cohorts/homepage-practice/session'), calls)
            self.assertIn(('POST','/admin/cohorts/homepage-practice/roster/append'), calls)
            self.assertEqual(calls[-1], ('GET','/v1/profile'))
            self.assertEqual((state/'local-participant-token.txt').read_text(), 'synthetic-participant')

    def test_windows_prepare_replaces_only_copy_and_records_its_actual_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); repo = root/'repo'; base = root/'installed'; state = root/'state'; state.mkdir()
            source = repo/'extensions/hypeproof-chat'; source.mkdir(parents=True)
            (source/'package.json').write_text('{"name":"hypeproof-chat"}', encoding='utf-8')
            payload = base/'resources/app'; shipped = payload/'extensions/hypeproof-chat'
            (shipped/'dist').mkdir(parents=True); (shipped/'webview-ui/dist').mkdir(parents=True)
            (payload/'product.json').write_text('{"nameShort":"HypeProof Studio"}', encoding='utf-8')
            (shipped/'package.json').write_text('{"name":"hypeproof-chat"}', encoding='utf-8')
            (shipped/'dist/extension.js').write_text('official', encoding='utf-8')
            (base/'HypeProof Studio.exe').write_bytes(b'signed shell')
            original = dev.file_manifest(base)
            def build(repo, stage):
                (stage/'webview').mkdir(parents=True)
                (stage/'extension.js').write_text('current local source', encoding='utf-8')
                (stage/'webview/index.html').write_text('current webview', encoding='utf-8')
                return {}
            with patch.object(dev, 'build', side_effect=build), patch.object(dev, 'app_running', return_value=False), patch.object(dev.subprocess, 'check_output', return_value='test'):
                app = dev.prepare(repo, base, state, 'local')
            receipt = json.loads((state/'receipt.json').read_text(encoding='utf-8'))
            self.assertEqual(receipt['extension_sha256'], dev.sha(app/'resources/app/extensions/hypeproof-chat/dist/extension.js'))
            self.assertEqual(dev.file_manifest(base), original)
            self.assertEqual(json.loads((app/'resources/app/product.json').read_text())['nameShort'], 'HypeProof Studio Dev')

    def test_only_fully_bundled_new_dependencies_can_use_an_older_shell(self):
        source = {'dependencies': {'new-js': '1'}}
        meta = {'inputs': {'node_modules/new-js/index.js': {}}, 'outputs': {'extension.js': {'imports': [{'path': 'vscode', 'external': True}]}}}
        dev.check_runtime_dependencies(source, {}, meta)
        with self.assertRaisesRegex(RuntimeError, 'Unbundled runtime dependency'):
            dev.check_runtime_dependencies(source, {}, {})
        meta['outputs']['extension.js']['imports'].append({'path': 'new-js/native', 'external': True})
        with self.assertRaisesRegex(RuntimeError, 'Unbundled runtime dependency'):
            dev.check_runtime_dependencies(source, {}, meta)

    def test_windows_identity_does_not_rename_shell_or_mutate_installed_app(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp)/'Studio'; root = app/'resources/app'; root.mkdir(parents=True)
            (root/'product.json').write_text(json.dumps({'nameShort':'HypeProof Studio', 'win32AppUserModelId':'HypeProof.Studio', 'updateUrl':'https://example.com'}), encoding='utf-8')
            (root/'package.json').write_text('{"name":"HypeProof Studio"}', encoding='utf-8')
            (app/'HypeProof Studio.exe').write_bytes(b'original signed shell')
            dev.configure_copy(app, 'windows-test')
            product = json.loads((root/'product.json').read_text(encoding='utf-8'))
            self.assertEqual(product['nameShort'], 'HypeProof Studio Dev')
            self.assertEqual(product['win32AppUserModelId'], 'HypeProof.Studio.Dev.windows-test')
            self.assertNotIn('updateUrl', product)
            self.assertEqual((app/'HypeProof Studio.exe').read_bytes(), b'original signed shell')
            self.assertEqual(json.loads((root/'package.json').read_text())['name'], 'HypeProof Studio')

    def test_windows_inspection_is_scoped_and_fails_closed(self):
        with patch.object(dev.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)) as inspect:
            self.assertFalse(dev.app_running(Path('isolated-dev')))
            self.assertEqual(inspect.call_args.kwargs['env']['HPS_DEV_APP_PATH'], str(Path('isolated-dev').resolve()))
            self.assertNotIn(str(Path('isolated-dev').resolve()), inspect.call_args.args[0][-1])
        with patch.object(dev.subprocess, 'run', return_value=subprocess.CompletedProcess([], 3)):
            with self.assertRaises(RuntimeError): dev.app_running(Path('isolated-dev'))

    def test_lock_excludes_another_windows_build(self):
        if os.name != 'nt': self.skipTest('Windows byte-range locking')
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            with dev.locked(state):
                with self.assertRaisesRegex(RuntimeError, 'Another development build'):
                    with dev.locked(state): pass
            with dev.locked(state): pass

    def test_explicit_cli_is_resolved_without_shell_or_credential_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            exe = Path(tmp)/'CLI with spaces.exe'; exe.write_bytes(b'cli')
            self.assertEqual(dev.resolve_cli('codex', exe), str(exe.resolve()))
            with self.assertRaises(RuntimeError): dev.resolve_cli('codex', Path(tmp)/'missing.exe')

    def test_local_setup_refuses_a_production_service_before_reading_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(dev, 'urlopen') as fetch:
                fetch.return_value.__enter__.return_value.read.return_value = b'{"service":"hypeproof-studio-api","env":"production"}'
                with self.assertRaisesRegex(RuntimeError, 'development Service'):
                    dev.setup_local_participant(Path(tmp)/'repo', Path(tmp)/'state')
                self.assertEqual(fetch.call_count, 1)

    def test_rejects_generated_js_shadowing_edited_typescript(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);src=root/'extensions/hypeproof-chat/webview-ui/src';src.mkdir(parents=True)
            (src/'WorkBrief.tsx').write_text('new UI')
            (src/'WorkBrief.js').write_text('stale UI')
            with patch.object(dev,'run') as run:
                with self.assertRaisesRegex(RuntimeError,'Shadowed TypeScript'):
                    dev.build(root,root/'stage')
                run.assert_not_called()

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
            with patch.dict(os.environ, {'HPS_TEST_TOKEN':'unrelated-test-account', 'HPS_TEST_E2E':'1'}),patch.object(dev.subprocess,'Popen') as popen,patch.object(dev.time,'sleep'):
                popen.return_value.poll.return_value=1
                with self.assertRaises(RuntimeError): dev.launch(app,state)
                self.assertEqual(popen.call_args.kwargs['env']['HPS_DEV_TOKEN_FILE'],str(state/'local-participant-token.txt'))
                self.assertTrue(any('--user-data-dir=' in s for s in popen.call_args.args[0]))
                self.assertNotIn('HPS_TEST_TOKEN', popen.call_args.kwargs['env'])
                self.assertNotIn('HPS_TEST_E2E', popen.call_args.kwargs['env'])

if __name__=='__main__': unittest.main()
