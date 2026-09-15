#!/usr/bin/env python3
"""Delegate requirement discovery to the canonical Harness checkout."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
common = Path(subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--git-common-dir'], text=True).strip())
if not common.is_absolute():
    common = root / common
harness = Path(os.environ.get('HYPEPROOF_HARNESS', common.resolve().parent.parent / 'hypeproof-harness'))
script = harness / 'scripts/work-discovery/discover.py'
if not script.is_file():
    sys.exit('Canonical Harness work discovery is unavailable. Update Harness or set HYPEPROOF_HARNESS. Work availability is unknown.')
raise SystemExit(subprocess.call([sys.executable, str(script), '--checkout', str(root), *sys.argv[1:]]))
