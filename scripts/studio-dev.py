#!/usr/bin/env python3
"""Build an isolated Studio development app on macOS arm64 or Windows."""
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
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
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

if os.name == 'nt':
    import msvcrt
else:
    import fcntl

REPO = Path(__file__).resolve().parents[1]
FORMAT = 'hps-studio-dev/1'


def run(args, **kwargs):
    hidden_capture = os.name == 'nt' and not any(key in kwargs for key in ('stdout', 'stderr', 'capture_output'))
    if os.name == 'nt':
        kwargs.setdefault('creationflags', subprocess.CREATE_NO_WINDOW)
    if hidden_capture:
        kwargs.update(capture_output=True, text=True, encoding='utf-8')
    try:
        result = subprocess.run([str(x) for x in args], check=True, **kwargs)
    except subprocess.CalledProcessError as error:
        if hidden_capture:
            sys.stderr.write((error.stdout or '') + (error.stderr or ''))
        raise
    if hidden_capture:
        sys.stdout.write(result.stdout or '')
        sys.stderr.write(result.stderr or '')
    return result


def is_mac_app(app):
    return app.suffix == '.app'


def app_resources(app):
    return app / ('Contents/Resources/app' if is_mac_app(app) else 'resources/app')


def default_base():
    if platform.system() == 'Windows':
        programs = Path(os.environ['LOCALAPPDATA']) / 'Programs'
        for name in ('HypeProof Studio', 'VSCodium'):
            candidate = programs / name
            if (candidate / 'resources/app/product.json').is_file():
                return candidate
        return programs / 'HypeProof Studio'
    return Path('/Applications/HypeProof Studio.app')


def resolve_cli(provider, explicit=None):
    found = str(explicit) if explicit else shutil.which(provider + ('.exe' if os.name == 'nt' else ''))
    found = found or shutil.which(provider)
    if found and os.name == 'nt' and Path(found).suffix.lower() != '.exe':
        # Resolve npm's native CLI without executing a shell shim or copying login files.
        package = Path(found).parent / 'node_modules' / ('@anthropic-ai/claude-code' if provider == 'claude' else '@openai/codex')
        candidates = [package / 'bin' / (provider + '.exe')]
        if provider == 'codex':
            target = 'aarch64' if platform.machine().lower() == 'arm64' else 'x86_64'
            triple = target + '-pc-windows-msvc'
            candidates += [package / 'vendor' / triple / 'codex/codex.exe',
                           package.parent / ('codex-win32-' + ('arm64' if target == 'aarch64' else 'x64')) / 'vendor' / triple / 'codex/codex.exe']
        found = next((str(p) for p in candidates if p.is_file()), None)
    if not found or not Path(found).is_file():
        raise RuntimeError('Install and log in to ' + provider + ' first. On Windows use a native .exe; --cli-executable can select it.')
    return str(Path(found).resolve())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def overlaps(a, b):
    a, b = a.resolve(), b.resolve()
    return a == b or a in b.parents or b in a.parents


def validate_paths(repo, base, state):
    if overlaps(state, base) or overlaps(state, repo):
        raise ValueError('State directory must be outside the checkout and installed app.')
    if state.is_symlink() or (hasattr(state, 'is_junction') and state.is_junction()):
        raise ValueError('State directory cannot be a symlink.')
    if state.exists() and any(state.iterdir()):
        marker = state / 'owner.json'
        if not marker.is_file() or json.loads(marker.read_text(encoding='utf-8')) != {'format': FORMAT, 'repo': str(repo.resolve())}:
            raise ValueError('Refusing to reuse a non-owned state directory.')


@contextmanager
def locked(state):
    with (state / 'build.lock').open('a+b') as handle:
        if os.name == 'nt':
            handle.write(b'0')
            handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise RuntimeError('Another development build owns this state directory.') from error
        else:
            fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == 'nt':
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def app_running(app):
    if not is_mac_app(app):
        env = dict(os.environ, HPS_DEV_APP_PATH=str(app.resolve()))
        script = "$ErrorActionPreference='Stop'; $root=$env:HPS_DEV_APP_PATH.TrimEnd('\\')+'\\'; $matches=Get-CimInstance Win32_Process -Filter \"Name='HypeProof Studio.exe'\"; if (@($matches | Where-Object { -not $_.ExecutablePath }).Count) { throw 'Cannot inspect Studio executable paths' }; if (@($matches | Where-Object { $_.ExecutablePath.StartsWith($root,[System.StringComparison]::OrdinalIgnoreCase) }).Count) { exit 0 }; exit 1"
        check = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                               env=env, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    else:
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
    root = app_resources(app)
    product_path = root / 'product.json'
    product = json.loads(product_path.read_text(encoding='utf-8'))
    product.update(nameShort='HypeProof Studio Dev', nameLong='HypeProof Studio Dev',
                   applicationName='hypeproof-studio-dev-' + identifier,
                   dataFolderName='.hypeproof-studio-dev-' + identifier,
                   darwinBundleIdentifier='ai.hypeproof.studio.dev.' + identifier,
                   urlProtocol='hypeproof-studio-dev-' + identifier)
    for key in ('updateUrl', 'downloadUrl'):
        product.pop(key, None)
    if not is_mac_app(app):
        product.update(win32AppUserModelId='HypeProof.Studio.Dev.' + identifier,
                       win32MutexName='hypeproof-studio-dev-' + identifier)
    product_path.write_text(json.dumps(product, indent=2), encoding='utf-8')
    if not is_mac_app(app):
        return
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
    # Bundlers resolve .js before .ts/.tsx. A previous emitting tsc run can
    # silently shadow edited source; never package an ambiguous source tree.
    for source in (ext / 'src', ext / 'webview-ui/src'):
        for js in source.rglob('*.js'):
            if js.with_suffix('.ts').exists() or js.with_suffix('.tsx').exists():
                raise RuntimeError(f'Shadowed TypeScript source: {js}. Move the generated JavaScript out of src before building.')
    esbuild = ext / 'node_modules/esbuild/lib/main.js'
    vite = ext / 'webview-ui/node_modules/vite/bin/vite.js'
    if not esbuild.exists() or not vite.exists():
        raise RuntimeError('Dependencies missing. Run npm ci in extensions/hypeproof-chat and its webview-ui directory.')
    stage.mkdir(parents=True, exist_ok=True)
    metadata = stage / 'bundle-inputs.json'
    run(['node', '-e', "const result=require('esbuild').buildSync({entryPoints:['src/extension.ts'],bundle:true,platform:'node',target:'node18',external:['vscode'],outfile:process.argv[1],metafile:true});require('fs').writeFileSync(process.argv[2],JSON.stringify(result.metafile))", stage / 'extension.js', metadata], cwd=ext)
    run(['node', vite, 'build', '--outDir', stage / 'webview', '--emptyOutDir'], cwd=ext / 'webview-ui')
    return json.loads(metadata.read_text(encoding='utf-8'))


def check_runtime_dependencies(source, shipped, metadata):
    for name, version in source.get('dependencies', {}).items():
        if shipped.get('dependencies', {}).get(name) == version:
            continue
        bundled = any(p.replace('\\', '/').startswith('node_modules/' + name + '/') for p in metadata.get('inputs', {}))
        external = any(imp.get('external') and (imp['path'] == name or imp['path'].startswith(name + '/'))
                       for output in metadata.get('outputs', {}).values() for imp in output.get('imports', []))
        if not bundled or external:
            raise RuntimeError('Unbundled runtime dependency differs from base app: ' + name + '. Use a compatible base app; launcher does not package new SDK dependencies.')


def prepare(repo, base, state, service):
    app = state / ('HypeProof Studio Dev.app' if is_mac_app(base) else 'HypeProof Studio Dev')
    if app_running(app):
        raise RuntimeError('Save your work and quit only the development app before applying changes. It will not be killed.')
    stage = state / 'build'
    metadata = build(repo, stage)
    before = file_manifest(base)
    candidate = state / ('candidate-' + uuid.uuid4().hex + ('.app' if is_mac_app(base) else ''))
    if is_mac_app(base):
        run(['/usr/bin/ditto', base, candidate])
    else:
        shutil.copytree(base, candidate, symlinks=True)
    target = app_resources(candidate) / 'extensions/hypeproof-chat'
    if not target.is_dir():
        raise RuntimeError('Installed base app has no bundled hypeproof-chat extension.')
    ext = repo / 'extensions/hypeproof-chat'
    source_manifest = json.loads((ext / 'package.json').read_text(encoding='utf-8'))
    shipped_manifest = json.loads((target / 'package.json').read_text(encoding='utf-8'))
    check_runtime_dependencies(source_manifest, shipped_manifest, metadata)
    shutil.copy2(stage / 'extension.js', target / 'dist/extension.js')
    shutil.rmtree(target / 'webview-ui/dist')
    shutil.copytree(stage / 'webview', target / 'webview-ui/dist')
    shutil.copy2(ext / 'package.json', target / 'package.json')
    configure_copy(candidate, hashlib.sha256(str(repo).encode()).hexdigest()[:12])
    if is_mac_app(base):
        run(['codesign', '--force', '--deep', '--sign', '-', candidate])
        run(['codesign', '--verify', '--deep', candidate])
    if before != file_manifest(base):
        raise RuntimeError('Installed app changed during preparation. Candidate not applied.')
    # Check again before switching: an app opened during build must not be replaced.
    if app_running(app):
        raise RuntimeError('Development app opened during build; candidate left unapplied.')
    backup = None
    if app.exists():
        backup = state / ('previous-' + uuid.uuid4().hex + '.inactive')
        app.rename(backup)
    try:
        candidate.rename(app)
    except Exception:
        if backup is not None:
            backup.rename(app)
        raise
    branch = subprocess.check_output(['git', 'branch', '--show-current'], cwd=repo, text=True, encoding='utf-8').strip()
    user = state / 'user-data/User'
    user.mkdir(parents=True, exist_ok=True)
    settings = user / 'settings.json'
    existing = json.loads(settings.read_text(encoding='utf-8')) if settings.exists() else {}
    settings.write_text(json.dumps(settings_for(existing, service, branch), ensure_ascii=False, indent=2), encoding='utf-8')
    workspace = state / 'workspace'
    workspace.mkdir(exist_ok=True)
    receipt = {'format': FORMAT, 'source': str(repo), 'branch': branch, 'app': str(app), 'platform': platform.system(),
               'service': service, 'official_app_unchanged': True, 'extension_sha256': sha(app_resources(app) / 'extensions/hypeproof-chat/dist/extension.js'),
               'previous_app': str(backup) if backup else None, 'prepared_at': time.time()}
    (state / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps(receipt, ensure_ascii=False, indent=2), flush=True)
    return app


def launch(app, state, local_runtime=None, debug_port=None):
    executable = (app / 'Contents/MacOS' / plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleExecutable']) if is_mac_app(app) else app / 'HypeProof Studio.exe'
    env = dict(os.environ)
    # Tests from another Studio window must not override this copy's local identity.
    for key in list(env):
        if key.startswith('HPS_TEST_'):
            env.pop(key)
    # The launcher already has the developer shell environment. VS Code's
    # second interactive-shell probe can hang on startup hooks.
    env['VSCODE_CLI'] = '1'
    for key in ('HPS_DEV_RUNTIME', 'HPS_DEV_PROVIDER', 'HPS_DEV_MODEL', 'HPS_DEV_EXECUTABLE'):
        env.pop(key, None)
    if local_runtime:
        env.update(HPS_DEV_RUNTIME='1', HPS_DEV_PROVIDER=local_runtime['provider'],
                   HPS_DEV_MODEL=local_runtime['model'], HPS_DEV_EXECUTABLE=local_runtime['executable'])
    # Never import the globally shared dev-stack token implicitly.
    env['HPS_DEV_TOKEN_FILE'] = str(state / 'local-participant-token.txt')
    # HPS_DEV_ISSUER_TOKEN_FILE: forwarded from the caller when set (review-pr.sh writes it).
    # dict(os.environ) above already carries it; no explicit override needed.
    args = [str(executable),
            '--user-data-dir=' + str(state / 'user-data'), '--extensions-dir=' + str(state / 'extensions'),
            '--new-window', '--skip-welcome', '--skip-release-notes', str(state / 'workspace')]
    if debug_port:
        args += ['--remote-debugging-port=' + str(debug_port), '--remote-debugging-address=127.0.0.1']
    options = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
    with (state / 'app.log').open('a', encoding='utf-8') as log:
        process = subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT, **options)
    time.sleep(3)
    if process.poll() is not None:
        raise RuntimeError('Development app exited during startup. Inspect app.log; launch is not verified.')
    print('Development process started: ' + str(process.pid) + '. Inspect the window; this is not an AI smoke test.')


def setup_local_participant(repo, state):
    base = 'http://127.0.0.1:8787'
    def request(method, path, body=None, authorization=None):
        headers = {'content-type': 'application/json'}
        if authorization:
            headers['authorization'] = authorization
        req = Request(base + path, method=method, headers=headers,
                      data=json.dumps(body).encode('utf-8') if body is not None else None)
        try:
            with urlopen(req, timeout=15) as response:
                return json.load(response)
        except (HTTPError, URLError) as error:
            raise RuntimeError('Local Service request failed: ' + path + '. Start the local Worker and check its admin configuration.') from error
    health = request('GET', '/v1/health')
    if health.get('service') != 'hypeproof-studio-api' or health.get('env') != 'dev':
        raise RuntimeError('--setup-local requires a development Service on 127.0.0.1:8787.')
    vars_path = repo / 'worker/.dev.vars'
    variables = {}
    if vars_path.is_file():
        for line in vars_path.read_text(encoding='utf-8-sig').splitlines():
            if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                name, value = line.split('=', 1)
                variables[name.strip()] = value.strip().strip('"').strip("'")
    password = os.environ.get('HPS_ADMIN_PASSWORD') or variables.get('HPS_ADMIN_PASSWORD')
    if not password:
        raise RuntimeError('Set the local HPS_ADMIN_PASSWORD in worker/.dev.vars before --setup-local.')
    auth = 'Basic ' + base64.b64encode((':' + password).encode('utf-8')).decode('ascii')
    cohort, profile = 'homepage-practice', 'homepage-practice-s1'
    user = 'dev-' + hashlib.sha256(str(repo.resolve()).encode()).hexdigest()[:12]
    detail = request('GET', '/admin/cohorts/' + cohort, authorization=auth)
    now = datetime.now(timezone.utc)
    active = detail.get('session')
    if active and datetime.fromisoformat(active['ends_at'].replace('Z', '+00:00')) > now:
        if active.get('profile_id') != profile:
            raise RuntimeError('An existing local activity uses another profile; it was not replaced.')
    else:
        request('POST', '/admin/cohorts/' + cohort + '/session',
                {'profile_id': profile, 'starts_at': now.isoformat(), 'ends_at': (now + timedelta(hours=4)).isoformat()}, auth)
    request('POST', '/admin/cohorts/' + cohort + '/roster/append', {'users': [user]}, auth)
    issued = request('POST', '/admin/tokens/issue', {'u': user, 'c': cohort, 'p': profile, 'hours': 4}, auth)
    token = issued.get('token')
    if not isinstance(token, str) or not token:
        raise RuntimeError('Local Service did not issue a participant code.')
    request('GET', '/v1/profile', authorization='Bearer ' + token)
    token_file = state / 'local-participant-token.txt'
    token_file.write_text(token, encoding='utf-8')
    token_file.chmod(0o600)
    print('Prepared local developer activity and participant code. The code is not printed or forwarded to the AI CLI.')


def stamp(repo):
    ext = repo / 'extensions/hypeproof-chat'
    files = [p for root in (ext / 'src', ext / 'webview-ui/src') for p in root.rglob('*') if p.is_file()]
    files += [ext / 'package.json', ext / 'webview-ui/package.json', ext / 'webview-ui/vite.config.ts']
    return tuple((str(p), p.stat().st_mtime_ns) for p in sorted(files))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'run', 'watch', 'status'])
    parser.add_argument('--base-app', type=Path)
    parser.add_argument('--state-dir', type=Path)
    parser.add_argument('--service', choices=['local', 'live'], default='local')
    parser.add_argument('--provider', choices=['claude', 'codex', 'service'], default='claude',
                        help='Development funding: local Claude Code subscription (default), Codex subscription, or Service API.')
    parser.add_argument('--cli-executable', type=Path, help='Explicit installed native Claude Code or Codex CLI.')
    parser.add_argument('--setup-local', action='store_true', help='Prepare a developer activity/code through an already running local development Service.')
    parser.add_argument('--debug-port', type=int, help='Optional loopback renderer debugging port for actual-app verification.')
    args = parser.parse_args()
    if not (platform.system() == 'Windows' or (platform.system() == 'Darwin' and platform.machine() == 'arm64')):
        raise RuntimeError('This development launcher supports macOS arm64 and Windows only.')
    if args.setup_local and args.service != 'local':
        raise ValueError('--setup-local cannot change a live Service.')
    if args.debug_port is not None and not 1024 <= args.debug_port <= 65535:
        raise ValueError('--debug-port must be 1024..65535.')
    args.base_app = args.base_app or default_base()
    state_parent = Path(os.environ['LOCALAPPDATA']) / 'HypeProofStudioDev' if platform.system() == 'Windows' else Path.home() / 'Library/Application Support/HypeProof Studio Development'
    state = args.state_dir or state_parent / hashlib.sha256(str(REPO).encode()).hexdigest()[:12]
    validate_paths(REPO, args.base_app, state)
    state = state.resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    (state / 'owner.json').write_text(json.dumps({'format': FORMAT, 'repo': str(REPO.resolve())}), encoding='utf-8')
    if args.action == 'status':
        print((state / 'receipt.json').read_text(encoding='utf-8') if (state / 'receipt.json').exists() else 'No prepared development app.')
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
        local_runtime = None
        if args.provider != 'service':
            if args.service != 'local':
                raise ValueError('Local subscription mode requires --service local. Use --provider service for production Service.')
            executable = resolve_cli(args.provider, args.cli_executable)
            try:
                checked = run(['node', REPO / 'scripts/local-runtime-probe.mjs', args.provider, executable], capture_output=True, text=True, encoding='utf-8')
            except subprocess.CalledProcessError as error:
                raise RuntimeError((error.stderr or '').strip() or 'Local CLI login check failed.') from None
            local_runtime = json.loads(checked.stdout)
            local_runtime['executable'] = executable
            print('Development connection: ' + local_runtime['label'] + ' / ' + local_runtime['model'], flush=True)
        with locked(state):
            if args.setup_local:
                setup_local_participant(REPO, state)
            app = prepare(REPO, args.base_app.resolve(), state, args.service)
            if args.action == 'run':
                launch(app, state, local_runtime, args.debug_port)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        print('Studio dev: ' + str(error), file=sys.stderr)
        sys.exit(1)
