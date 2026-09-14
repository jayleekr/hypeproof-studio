#!/usr/bin/env python3
"""Build a disposable Mac Studio app without changing the installed app or release pipeline."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import time
import uuid

REPO = Path(__file__).resolve().parents[1]
FORMAT = 'hps-studio-dev/1'


def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, **kwargs)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def overlaps(a, b):
    a, b = a.resolve(), b.resolve()
    return a == b or a in b.parents or b in a.parents


def validate_paths(repo, base, state):
    if overlaps(state, base) or overlaps(state, repo):
        raise ValueError('State directory must be outside the checkout and installed app.')
    if state.is_symlink():
        raise ValueError('State directory cannot be a symlink.')
    if state.exists() and any(state.iterdir()):
        marker = state / 'owner.json'
        if not marker.is_file() or json.loads(marker.read_text()) != {'format': FORMAT, 'repo': str(repo.resolve())}:
            raise ValueError('Refusing to reuse a non-owned state directory.')


@contextmanager
def locked(state):
    with (state / 'build.lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def app_running(app):
    check = subprocess.run(['pgrep', '-f', re.escape(str(app)) + '/Contents/'], capture_output=True, text=True)
    if check.returncode not in (0, 1):
        raise RuntimeError('Cannot inspect processes; refusing to replace the development app.')
    return check.returncode == 0


def file_manifest(root):
    result = {}
    for p in sorted(root.rglob('*')):
        if p.is_symlink():
            result[str(p.relative_to(root))] = 'link:' + os.readlink(p)
        elif p.is_file():
            result[str(p.relative_to(root))] = sha(p)
    return result


def configure_copy(app, identifier):
    root = app / 'Contents/Resources/app'
    product_path = root / 'product.json'
    product = json.loads(product_path.read_text())
    product.update(nameShort='HypeProof Studio Dev', nameLong='HypeProof Studio Dev',
                   applicationName='hypeproof-studio-dev-' + identifier,
                   dataFolderName='.hypeproof-studio-dev-' + identifier,
                   darwinBundleIdentifier='ai.hypeproof.studio.dev.' + identifier,
                   urlProtocol='hypeproof-studio-dev-' + identifier)
    for key in ('updateUrl', 'downloadUrl'):
        product.pop(key, None)
    product_path.write_text(json.dumps(product, indent=2))
    info = app / 'Contents/Info.plist'
    data = plistlib.loads(info.read_bytes())
    # Keep CFBundleName, executable and package.json name: Electron locates its
    # shipped Helper apps by that name. Changing it causes a fatal launch error.
    data['CFBundleIdentifier'] = product['darwinBundleIdentifier']
    data['CFBundleDisplayName'] = 'HypeProof Studio Dev'
    data.pop('CFBundleURLTypes', None)
    info.write_bytes(plistlib.dumps(data))


def settings_for(existing, service, branch):
    result = dict(existing)
    result.update({'update.mode': 'none', 'extensions.autoUpdate': False,
                   'extensions.autoCheckUpdates': False,
                   'window.title': '[DEV · ' + service + ' · ' + branch + '] ${activeEditorShort} — ${rootName}',
                   'hypeproofChat.proxyUrl': 'http://127.0.0.1:8787/v1' if service == 'local' else 'https://api.hypeproof-ai.xyz/v1'})
    colors = dict(result.get('workbench.colorCustomizations', {}))
    colors.update({'titleBar.activeBackground': '#493262', 'titleBar.activeForeground': '#ffffff'})
    result['workbench.colorCustomizations'] = colors
    return result


def build(repo, stage):
    ext = repo / 'extensions/hypeproof-chat'
    esbuild = ext / 'node_modules/.bin/esbuild'
    vite = ext / 'webview-ui/node_modules/vite/bin/vite.js'
    if not esbuild.exists() or not vite.exists():
        raise RuntimeError('Dependencies missing. Run npm ci in extensions/hypeproof-chat and its webview-ui directory.')
    stage.mkdir(parents=True, exist_ok=True)
    run([esbuild, 'src/extension.ts', '--bundle', '--platform=node', '--target=node18', '--external:vscode', '--outfile=' + str(stage / 'extension.js')], cwd=ext)
    run(['node', vite, 'build', '--outDir', stage / 'webview', '--emptyOutDir'], cwd=ext / 'webview-ui')


def prepare(repo, base, state, service):
    app = state / 'HypeProof Studio Dev.app'
    if app_running(app):
        raise RuntimeError('Save your work and quit only the development app before applying changes. It will not be killed.')
    stage = state / 'build'
    build(repo, stage)
    before = file_manifest(base)
    candidate = state / ('candidate-' + uuid.uuid4().hex + '.app')
    run(['/usr/bin/ditto', base, candidate])
    target = candidate / 'Contents/Resources/app/extensions/hypeproof-chat'
    if not target.is_dir():
        raise RuntimeError('Installed base app has no bundled hypeproof-chat extension.')
    ext = repo / 'extensions/hypeproof-chat'
    source_manifest = json.loads((ext / 'package.json').read_text())
    shipped_manifest = json.loads((target / 'package.json').read_text())
    if source_manifest.get('dependencies', {}) != shipped_manifest.get('dependencies', {}):
        raise RuntimeError('Runtime dependencies differ from base app. Use a compatible base app; launcher does not package new SDK dependencies.')
    shutil.copy2(stage / 'extension.js', target / 'dist/extension.js')
    shutil.rmtree(target / 'webview-ui/dist')
    shutil.copytree(stage / 'webview', target / 'webview-ui/dist')
    shutil.copy2(ext / 'package.json', target / 'package.json')
    configure_copy(candidate, hashlib.sha256(str(repo).encode()).hexdigest()[:12])
    run(['codesign', '--force', '--deep', '--sign', '-', candidate])
    run(['codesign', '--verify', '--deep', candidate])
    if before != file_manifest(base):
        raise RuntimeError('Installed app changed during preparation. Candidate not applied.')
    # Check again before switching: an app opened during build must not be replaced.
    if app_running(app):
        raise RuntimeError('Development app opened during build; candidate left unapplied.')
    backup = None
    if app.exists():
        backup = state / ('previous-' + uuid.uuid4().hex + '.app')
        app.rename(backup)
    try:
        candidate.rename(app)
    except Exception:
        if backup is not None:
            backup.rename(app)
        raise
    branch = subprocess.check_output(['git', 'branch', '--show-current'], cwd=repo, text=True).strip()
    user = state / 'user-data/User'
    user.mkdir(parents=True, exist_ok=True)
    settings = user / 'settings.json'
    existing = json.loads(settings.read_text()) if settings.exists() else {}
    settings.write_text(json.dumps(settings_for(existing, service, branch), ensure_ascii=False, indent=2))
    workspace = state / 'workspace'
    workspace.mkdir(exist_ok=True)
    receipt = {'format': FORMAT, 'source': str(repo), 'branch': branch, 'app': str(app),
               'service': service, 'official_app_unchanged': True, 'extension_sha256': sha(app / 'Contents/Resources/app/extensions/hypeproof-chat/dist/extension.js'),
               'previous_app': str(backup) if backup else None, 'prepared_at': time.time()}
    (state / 'receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt, ensure_ascii=False, indent=2), flush=True)
    return app


def launch(app, state):
    executable = plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleExecutable']
    env = dict(os.environ)
    # Never import the globally shared dev-stack token implicitly.
    env['HPS_DEV_TOKEN_FILE'] = str(state / 'local-participant-token.txt')
    with (state / 'app.log').open('a') as log:
        process = subprocess.Popen([str(app / 'Contents/MacOS' / executable),
            '--user-data-dir=' + str(state / 'user-data'), '--extensions-dir=' + str(state / 'extensions'),
            '--new-window', '--skip-welcome', '--skip-release-notes', str(state / 'workspace')],
            env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    time.sleep(3)
    if process.poll() is not None:
        raise RuntimeError('Development app exited during startup. Inspect app.log; launch is not verified.')
    print('Development process started: ' + str(process.pid) + '. Inspect the window; this is not an AI smoke test.')


def stamp(repo):
    ext = repo / 'extensions/hypeproof-chat'
    files = [p for root in (ext / 'src', ext / 'webview-ui/src') for p in root.rglob('*') if p.is_file()]
    files += [ext / 'package.json', ext / 'webview-ui/package.json', ext / 'webview-ui/vite.config.ts']
    return tuple((str(p), p.stat().st_mtime_ns) for p in sorted(files))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'run', 'watch', 'status'])
    parser.add_argument('--base-app', type=Path, default=Path('/Applications/HypeProof Studio.app'))
    parser.add_argument('--state-dir', type=Path)
    parser.add_argument('--service', choices=['local', 'live'], default='local')
    args = parser.parse_args()
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('This development launcher supports macOS arm64 only.')
    state = args.state_dir or Path.home() / 'Library/Application Support/HypeProof Studio Development' / hashlib.sha256(str(REPO).encode()).hexdigest()[:12]
    validate_paths(REPO, args.base_app, state)
    state = state.resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    (state / 'owner.json').write_text(json.dumps({'format': FORMAT, 'repo': str(REPO.resolve())}))
    if args.action == 'status':
        print((state / 'receipt.json').read_text() if (state / 'receipt.json').exists() else 'No prepared development app.')
    elif args.action == 'watch':
        previous = None
        while True:
            current = stamp(REPO)
            if current != previous:
                try:
                    with locked(state):
                        build(REPO, state / 'build')
                    print('Built. Save and quit the development app, then run again to apply.', flush=True)
                except subprocess.CalledProcessError:
                    print('Build failed; running app unchanged.', flush=True)
                previous = current
            time.sleep(1)
    else:
        with locked(state):
            app = prepare(REPO, args.base_app.resolve(), state, args.service)
            if args.action == 'run':
                launch(app, state)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        print('Studio dev: ' + str(error), file=sys.stderr)
        sys.exit(1)
