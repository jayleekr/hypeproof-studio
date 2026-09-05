#!/usr/bin/env python3
"""Every bash-shaped `run:` block on a Windows runner must declare `shell: bash`.

Why this exists: `build-windows.yml` runs on `windows-*`, where GitHub's default
shell is PowerShell. A `run:` body copied from a macOS or Linux workflow parses
as PowerShell and dies on the first POSIX token it meets:

    ParserError: Missing expression after unary operator '--'

That is exactly how v0.0.0-rc.2 failed — the release published, then the mirror
dispatch step (lifted verbatim from build-mac.yml) blew up on `--repo`.

The earlier control for that change asserted the step EXISTED and that the job
had `actions: write`. Both were true. Neither answered whether the step could
run on the platform it was placed on, so it passed while the thing it was
guarding was broken. This check closes that gap.

Heuristic, deliberately: it flags POSIX-only constructs that PowerShell cannot
parse or silently misreads. False positives are cheap to silence with an
explicit `shell:`; a false negative is a release that publishes and then fails.

Usage:  python3 scripts/check-workflow-shells.py
Exit:   0 clean, 1 violations, 2 malformed input.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("check-workflow-shells: PyYAML required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)

# Constructs PowerShell either cannot parse or reads differently from bash.
POSIX_MARKERS = (
    (re.compile(r"^\s*set -[euxo]"), "set -e/-u/-o pipefail"),
    (re.compile(r"\\\s*$", re.M), "backslash line continuation"),
    (re.compile(r"\$\{[A-Za-z_#]"), "${...} parameter expansion"),
    (re.compile(r"\|\|\s*\{"), "|| { ... } group"),
    (re.compile(r"\[\[ "), "[[ ]] test"),
    (re.compile(r"^\s*(if|for|while)\b.*;\s*then|do\s*$", re.M), "POSIX control flow"),
)


def windows_jobs(doc: dict) -> list[tuple[str, dict]]:
    out = []
    for name, job in (doc.get("jobs") or {}).items():
        runs_on = job.get("runs-on")
        text = " ".join(runs_on) if isinstance(runs_on, list) else str(runs_on or "")
        if "windows" in text.lower():
            out.append((name, job))
    return out


def check(root: Path) -> list[str]:
    problems: list[str] = []
    for wf in sorted((root / ".github" / "workflows").glob("*.yml")):
        try:
            doc = yaml.safe_load(wf.read_text())
        except yaml.YAMLError as err:
            problems.append(f"{wf.name}: not valid YAML — {err}")
            continue
        if not isinstance(doc, dict):
            continue

        for job_name, job in windows_jobs(doc):
            job_shell = ((job.get("defaults") or {}).get("run") or {}).get("shell")
            wf_shell = ((doc.get("defaults") or {}).get("run") or {}).get("shell")
            for step in job.get("steps") or []:
                body = step.get("run")
                if not isinstance(body, str):
                    continue
                shell = step.get("shell") or job_shell or wf_shell
                if shell:  # explicit — the author chose, whatever they chose
                    continue
                hits = [why for rx, why in POSIX_MARKERS if rx.search(body)]
                if hits:
                    problems.append(
                        f"{wf.name} :: job '{job_name}' :: step "
                        f"'{step.get('name', '<unnamed>')}' uses {', '.join(sorted(set(hits)))} "
                        f"but declares no `shell:` — it will run under PowerShell."
                    )
    return problems


def main() -> int:
    problems = check(Path(__file__).resolve().parent.parent)
    if not problems:
        print("check-workflow-shells: OK")
        return 0
    print(f"check-workflow-shells: {len(problems)} violation(s)\n", file=sys.stderr)
    for p in problems:
        print(f"  - {p}", file=sys.stderr)
    print(
        "\nAdd `shell: bash` to the step (or set a job/workflow default).",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
