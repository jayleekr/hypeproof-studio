#!/usr/bin/env python3
"""CLI: issue a workshop token.

Usage:
  HPS_SIGNING_SECRET="..." python issue_token.py --user-name "참가자A" --hours 8
"""

from __future__ import annotations

import argparse
import sys

from tokens import issue, TokenError


def main() -> int:
    ap = argparse.ArgumentParser(description="Issue a HypeProof Studio workshop token.")
    ap.add_argument("--user-name", required=True, help="Display name for the workshop participant")
    ap.add_argument("--hours", type=int, default=8, help="Token lifetime in hours (default 8)")
    args = ap.parse_args()

    try:
        token = issue(args.user_name, hours=args.hours)
    except TokenError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
