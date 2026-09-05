#!/usr/bin/env python3
"""The mirror job's timeout must outlast the wait loop it contains.

`mirror-release.yml` waits for every platform asset before mirroring, because a
half-mirrored release once left `install.ps1` failing closed (#632). The loop
budgets `WAIT_TIMEOUT_MIN` minutes for that — sized, per its own comment, to
cover two builds that each take 1-2 hours.

It was wrapped in a job with `timeout-minutes: 20`.

So the loop could never reach a seventh of its own budget, and the capability
#632 added was unreachable by design. `v0.0.0-rc.3` hit it precisely: cancelled
at 20.3 minutes while waiting for a mac asset that a broken signing step (#697)
was never going to produce. The mirror never ran.

Nothing was red about that configuration. Both numbers looked deliberate; they
were simply never compared. This check compares them.

Usage:  python3 scripts/check-mirror-timeout.py
Exit:   0 clean, 1 the job cannot outlast its own wait, 2 malformed input.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("check-mirror-timeout: PyYAML required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)

WORKFLOW = ".github/workflows/mirror-release.yml"
# Mirroring itself (download every asset, re-upload, verify) after the wait ends.
MARGIN_MIN = 20


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    path = root / WORKFLOW
    if not path.exists():
        print(f"check-mirror-timeout: {WORKFLOW} not found", file=sys.stderr)
        return 2

    raw = path.read_text()
    try:
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as err:
        print(f"check-mirror-timeout: not valid YAML — {err}", file=sys.stderr)
        return 2

    job = (doc.get("jobs") or {}).get("mirror")
    if not isinstance(job, dict):
        print("check-mirror-timeout: no `mirror` job", file=sys.stderr)
        return 2

    job_timeout = job.get("timeout-minutes")
    if not isinstance(job_timeout, int):
        print("check-mirror-timeout: mirror job declares no integer timeout-minutes", file=sys.stderr)
        return 1

    # WAIT_TIMEOUT_MIN lives in a step's env; read it from the parsed steps, and
    # fall back to the raw text so a restructure cannot make this check silently
    # stop finding it (which is the failure mode the script exists to prevent).
    waits: list[int] = []
    for step in job.get("steps") or []:
        val = (step.get("env") or {}).get("WAIT_TIMEOUT_MIN")
        if val is not None:
            try:
                waits.append(int(str(val).strip().strip('"').strip("'")))
            except ValueError:
                pass
    if not waits:
        m = re.search(r'WAIT_TIMEOUT_MIN:\s*"?(\d+)"?', raw)
        if m:
            waits.append(int(m.group(1)))

    if not waits:
        print(
            "check-mirror-timeout: WAIT_TIMEOUT_MIN not found — if the wait loop was "
            "removed, delete this check too; if it was renamed, update this check.",
            file=sys.stderr,
        )
        return 1

    wait = max(waits)
    need = wait + MARGIN_MIN
    if job_timeout < need:
        print(
            f"check-mirror-timeout: the mirror job cannot outlast its own wait\n\n"
            f"  job timeout-minutes : {job_timeout}\n"
            f"  WAIT_TIMEOUT_MIN    : {wait}\n"
            f"  required            : >= {need}  (wait + {MARGIN_MIN} for the mirroring itself)\n\n"
            f"The job dies before the loop can finish waiting, so the wait is "
            f"decorative and a late platform asset is never mirrored.",
            file=sys.stderr,
        )
        return 1

    print(f"check-mirror-timeout: OK (job {job_timeout}min >= wait {wait}min + {MARGIN_MIN}min margin)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
