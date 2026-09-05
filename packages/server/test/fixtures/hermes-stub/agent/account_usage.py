"""`agent.account_usage`, reduced to what the bridge's `usage` verb touches.

The real module talks to the Codex backend. This one reads a JSON script out
of `SLICK_TEST_USAGE` and either returns the snapshot it describes or raises
the exception it names, so every branch the bridge has — signed out, HTTP 401,
a timeout, a plan with banked resets — is a fixture rather than a network.

The dataclasses are copied field-for-field from `agent/account_usage.py`,
including `available`'s rule, because the bridge reads them by attribute and a
shape that drifted here would let a broken payload pass.
"""

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Tuple


class AuthError(Exception):
    """`hermes_cli.auth.AuthError` — no usable credential for this profile."""


class _Response:
    def __init__(self, status_code):
        self.status_code = status_code


class HTTPStatusError(Exception):
    """`httpx.HTTPStatusError`, as far as the bridge's classifier reads it."""

    def __init__(self, message, status_code):
        super().__init__(message)
        self.response = _Response(status_code)


class ConnectTimeout(Exception):
    """`httpx.ConnectTimeout` — the shape of every "could not reach it"."""


@dataclass(frozen=True)
class AccountUsageWindow:
    label: str
    used_percent: Optional[float] = None
    reset_at: Optional[datetime] = None
    detail: Optional[str] = None


@dataclass(frozen=True)
class AccountUsageSnapshot:
    provider: str
    source: str
    fetched_at: datetime
    title: str = "Account limits"
    plan: Optional[str] = None
    windows: Tuple[AccountUsageWindow, ...] = ()
    details: Tuple[str, ...] = ()
    unavailable_reason: Optional[str] = None

    @property
    def available(self) -> bool:
        return bool(self.windows or self.details) and not self.unavailable_reason


def _script():
    raw = os.environ.get("SLICK_TEST_USAGE", "")
    return json.loads(raw) if raw.strip() else {}


def _parse_dt(value):
    if not value:
        return None
    text = str(value)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _raise(kind):
    """Whatever the script said should go wrong, in the real module's terms."""
    if kind == "auth":
        raise AuthError("no codex credentials")
    if kind == "pool":
        raise RuntimeError("No available openai-codex credential in credential pool")
    if kind == "timeout":
        raise ConnectTimeout("connect timed out to https://chatgpt.com/backend-api")
    if isinstance(kind, str) and kind.startswith("http:"):
        raise HTTPStatusError(
            # A URL and a token-shaped string, so the scrubbing is exercised by
            # the one path that carries provider text into an error message.
            "Server error 'x' for url 'https://chatgpt.com/backend-api/codex/usage'",
            int(kind.split(":", 1)[1]),
        )
    if kind == "boom":
        raise ValueError("sk-live-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked into a message")


def _snapshot(script):
    windows = tuple(
        AccountUsageWindow(
            label=window.get("label", "Limit"),
            used_percent=window.get("used_percent"),
            reset_at=_parse_dt(window.get("reset_at")),
            detail=window.get("detail"),
        )
        for window in script.get("windows", ())
    )
    return AccountUsageSnapshot(
        provider=script.get("provider", "openai-codex"),
        source=script.get("source", "usage_api"),
        fetched_at=_parse_dt(script.get("fetched_at")) or datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc),
        plan=script.get("plan"),
        windows=windows,
        details=tuple(script.get("details", ())),
        unavailable_reason=script.get("unavailable_reason"),
    )


def _fetch_codex_account_usage(base_url=None, api_key=None):
    script = _script()
    _raise(script.get("raise"))
    if script.get("none"):
        return None
    return _snapshot(script)


def fetch_account_usage(provider, base_url=None, api_key=None):
    """The sanctioned entry point: never raises, `None` when it cannot answer."""
    normalized = str(provider or "").strip().lower()
    if normalized != "openai-codex":
        return None
    try:
        return _fetch_codex_account_usage(base_url=base_url, api_key=api_key)
    except Exception:
        return None
