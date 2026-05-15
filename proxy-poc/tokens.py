"""Workshop token issue + verify.

Token format: base64url(payload) + "." + base64url(hmac-sha256(payload))
Payload (JSON): {"u": "<user_name>", "exp": <unix_ts>, "iat": <unix_ts>, "v": 1}

Tokens are stateless. To revoke all outstanding tokens, rotate HPS_SIGNING_SECRET.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass


class TokenError(Exception):
    pass


@dataclass
class TokenPayload:
    user_name: str
    issued_at: int
    expires_at: int
    version: int = 1


def _b64u_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _signing_secret() -> bytes:
    secret = os.environ.get("HPS_SIGNING_SECRET", "")
    if not secret or len(secret) < 16:
        raise TokenError("HPS_SIGNING_SECRET must be set (>= 16 chars)")
    return secret.encode("utf-8")


def issue(user_name: str, hours: int = 8) -> str:
    if not user_name or len(user_name) > 64:
        raise TokenError("user_name required (<=64 chars)")
    now = int(time.time())
    payload = {
        "u": user_name,
        "iat": now,
        "exp": now + hours * 3600,
        "v": 1,
    }
    payload_bytes = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(_signing_secret(), payload_bytes, hashlib.sha256).digest()
    return f"{_b64u_encode(payload_bytes)}.{_b64u_encode(sig)}"


def verify(token: str) -> TokenPayload:
    """Returns parsed payload if valid. Raises TokenError otherwise."""
    if not token or "." not in token:
        raise TokenError("malformed token")
    payload_b64, sig_b64 = token.split(".", 1)
    try:
        payload_bytes = _b64u_decode(payload_b64)
        sig = _b64u_decode(sig_b64)
    except Exception as exc:
        raise TokenError("malformed token") from exc

    expected = hmac.new(_signing_secret(), payload_bytes, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        raise TokenError("invalid signature")

    try:
        p = json.loads(payload_bytes)
    except Exception as exc:
        raise TokenError("malformed payload") from exc

    if p.get("v") != 1:
        raise TokenError("unsupported token version")
    if int(p.get("exp", 0)) < int(time.time()):
        raise TokenError("token expired")
    if not p.get("u"):
        raise TokenError("token missing user")

    return TokenPayload(
        user_name=p["u"],
        issued_at=int(p["iat"]),
        expires_at=int(p["exp"]),
        version=int(p["v"]),
    )
