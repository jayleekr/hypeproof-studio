#!/usr/bin/env python3
"""Enforce the two registry invariants from docs/plan/vessel-and-modules.md §5.

CI checks exactly two things, and deliberately nothing more:

  1. Every top-level directory is either claimed by a products.yaml entry or
     listed in `non_product_directories`. This is the gate that stops something
     landing in the vessel without answering the four admission questions.

  2. Every declared `drift_lock` file (plus any `drift_lock_extra`) exists
     AND is named in a test script.
     Existence alone is not enough: this repo has already shipped tests that
     were never wired into `npm test` and therefore never ran (the issuer smoke
     tests). A contract test that does not run is not a contract.

Layer judgment and contract design are not machine-checkable. The artifact of
the admission process is that a human wrote the page; this script only makes
sure the page exists and its claims are not empty.

Usage:  python3 scripts/check-registry.py [--repo-root PATH]
Exit:   0 clean, 1 violations found, 2 registry itself is malformed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("check-registry: PyYAML is required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)


def load_registry(root: Path) -> dict:
    path = root / "products.yaml"
    if not path.exists():
        print(f"check-registry: {path} not found", file=sys.stderr)
        sys.exit(2)
    try:
        data = yaml.safe_load(path.read_text())
    except yaml.YAMLError as err:
        print(f"check-registry: products.yaml is not valid YAML\n{err}", file=sys.stderr)
        sys.exit(2)
    if not isinstance(data, dict) or "entries" not in data:
        print("check-registry: products.yaml must be a mapping with an `entries` key", file=sys.stderr)
        sys.exit(2)
    return data


def top_level_dirs(root: Path) -> set[str]:
    """Tracked, non-hidden directories at the repo root."""
    return {
        p.name
        for p in root.iterdir()
        if p.is_dir() and not p.name.startswith(".") and p.name != "node_modules"
    }


def test_script_text(root: Path) -> str:
    """Concatenate every package.json `scripts` block in the repo.

    A drift lock counts as wired if its path appears anywhere in a script — the
    runner may be an && chain (worker), a glob, or a bespoke command.
    """
    chunks: list[str] = []
    for pkg in root.rglob("package.json"):
        if "node_modules" in pkg.parts:
            continue
        try:
            scripts = json.loads(pkg.read_text()).get("scripts", {})
        except (json.JSONDecodeError, OSError):
            continue
        if isinstance(scripts, dict):
            chunks.extend(str(v) for v in scripts.values())
    return "\n".join(chunks)


def check(root: Path) -> list[str]:
    reg = load_registry(root)
    entries = reg.get("entries") or []
    planned = reg.get("planned") or []
    allowed = set(reg.get("non_product_directories") or [])
    problems: list[str] = []

    # ---- invariant 1: every top-level directory is accounted for -----------
    claimed: set[str] = set()
    for e in entries:
        d = e.get("directory")
        if d:
            claimed.add(Path(d).parts[0])

    for name in sorted(top_level_dirs(root)):
        if name in claimed or name in allowed:
            continue
        hint = ""
        for p in planned:
            if p.get("directory") and Path(p["directory"]).parts[0] == name:
                hint = (
                    f" It is listed under `planned` as '{p.get('name')}'"
                    f" (plan task {p.get('plan_task')}) — move it into `entries`"
                    " in the PR that creates it."
                )
                break
        problems.append(
            f"top-level directory '{name}/' has no products.yaml entry and is not in "
            f"non_product_directories.{hint}"
        )

    # ---- invariant 2: drift locks exist and actually run --------------------
    scripts_blob = test_script_text(root)
    for e in entries:
        name = e.get("name", "<unnamed>")
        lock = e.get("drift_lock")
        if not lock:
            problems.append(f"entry '{name}' declares no drift_lock (gate 3).")
            continue
        # `drift_lock_extra` (optional list) holds additional lock files for an
        # entry whose contract grew a second surface. Chalk uses it: one lock
        # pins the cohort-state shape, another pins the studio-logs read path
        # and its key layout against the write path's. Extras are held to the
        # SAME two rules as the primary lock — a declared lock that does not
        # exist, or exists but never runs, is not a contract.
        extra = e.get("drift_lock_extra") or []
        if not isinstance(extra, list):
            problems.append(f"entry '{name}': drift_lock_extra must be a list of paths.")
            extra = []
        for lock_decl in [lock, *extra]:
            lock_path = root / lock_decl
            if not lock_path.exists():
                problems.append(f"entry '{name}': drift_lock '{lock_decl}' does not exist.")
                continue
            basename = Path(lock_decl).name
            if basename not in scripts_blob and lock_decl not in scripts_blob:
                problems.append(
                    f"entry '{name}': drift_lock '{lock_decl}' exists but is not named in any "
                    "package.json test script — it would never run."
                )

    # ---- registry hygiene: gates answered, layers valid --------------------
    layers = set((reg.get("layers") or {}).keys())
    for e in entries:
        name = e.get("name", "<unnamed>")
        if e.get("layer") not in layers:
            problems.append(f"entry '{name}': layer '{e.get('layer')}' is not one of {sorted(layers)}.")
        if "exit_plan" not in e:
            problems.append(f"entry '{name}': no exit_plan key (gate 4) — use null with a note if genuinely n/a.")
        contract = e.get("contract")
        if not isinstance(contract, dict) or len(contract) != 1:
            problems.append(
                f"entry '{name}': contract must declare exactly one format (gate 2); "
                f"got {contract!r}."
            )

    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", default=".", type=Path)
    args = ap.parse_args()
    root = args.repo_root.resolve()

    problems = check(root)
    if not problems:
        print("check-registry: OK")
        return 0
    print(f"check-registry: {len(problems)} violation(s)\n", file=sys.stderr)
    for p in problems:
        print(f"  - {p}", file=sys.stderr)
    print(
        "\nSee docs/plan/vessel-and-modules.md §5 for what each gate asks.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
