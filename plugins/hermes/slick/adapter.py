"""
Slick Platform Adapter for Hermes Agent.

Slick is a local-first Slack-alike: a SQLite workspace fronted by a small
daemon (``slick daemon start``, default ``http://127.0.0.1:4477``) that speaks
JSON over HTTP and streams every workspace mutation as Server-Sent Events.
That is the whole integration surface, so this adapter needs no SDK — urllib
and asyncio from the standard library are enough.

Inbound
    ``GET /api/stream`` is tailed by a background asyncio task.  Each frame is
    a hydrated event (``{seq, type, channelId, message: {...}}``); the adapter
    keeps ``message.created`` events whose message was written by a human and
    turns them into ``MessageEvent``s.  The SSE ``id:`` field is the event's
    ``seq``, which is also what ``Last-Event-ID`` resumes from — a reconnect
    therefore replays exactly what was missed rather than the whole log.

Outbound
    ``POST /api/channels/<ref>/messages`` for a new root message and
    ``POST /api/messages/<root>/replies`` to answer inside a thread.  Hermes
    always posts with ``author.kind = "agent"``: that is what keeps the
    adapter from reading its own replies back off the stream and answering
    itself forever.

Configuration
    Nothing is mandatory for a local workspace.  ``slickd`` publishes its url
    and token to ``$SLICK_HOME/daemon.json`` (default ``~/.slick``) on
    startup, so the adapter reads that rendezvous file instead of making the
    operator copy a token into two places, and the listen scope defaults to
    ``*`` — every channel.  A workspace started with ``--no-auth`` has no
    token at all, which is a valid setup, not an error.

    ::

        gateway:
          platforms:
            slick:
              enabled: true
              extra:
                channel: "*"          # or "general", or "a,b,c"
                home_channel: general # cron / notification target
                allowed_users: []     # adapter-side filter, see the warning

    Or via environment variables (which take precedence):
    SLICK_URL, SLICK_TOKEN, SLICK_CHANNEL, SLICK_HOME_CHANNEL,
    SLICK_ALLOWED_USERS, SLICK_AGENT_ID, SLICK_AGENT_LABEL,
    SLICK_REQUEST_TIMEOUT, SLICK_STREAM_TIMEOUT, SLICK_RETRY_SECONDS

Model badge
    Slick badges every agent message with what answered it, read from
    ``metadata._model`` (``apps/web/js/app.js`` ``messageModel``) — Slick's own
    ``agent serve`` stamps that key when it posts a reply.  Hermes knows the
    same fact but never routes it to an adapter: the metadata handed to
    :meth:`SlickAdapter.send` is routing information, and the model appears
    only in the ``agent:end`` event the gateway fires just before delivery.
    So the adapter subscribes to that event and stamps the reply itself.

Live progress
    Hermes fires observer hooks while a turn is still running — one per
    streamed token, one on each side of every tool call — and Slick has two
    routes that draw them: ``POST /api/stream/delta`` for the draft answer and
    ``POST /api/thinking`` for the box of steps above it.  Neither route
    writes anything down, so a request that never lands costs a flicker and
    never an answer.

    Those hooks are given one daemon thread apiece and a bounded queue that
    drops its oldest entry when it fills, so a callback that makes an HTTP
    request per token loses deltas without saying so.  Everything here
    therefore buffers and returns, and one timer thread coalesces a thread's
    deltas into a request every 150ms.

    What this deliberately does not do is turn on the gateway's own streaming
    (``streaming.enabled``) or claim ``SUPPORTS_MESSAGE_EDITING``.  That path
    grows a real message by editing it, and ``gateway/platforms/base.py``
    answers ``edit_message`` with ``SendResult(success=False, error="Not
    supported")`` for an adapter that has not written one — after which
    ``GatewayStreamConsumer`` disables edits for the rest of the run.  Every
    turn would strand a half-finished message and then append the whole answer
    again beneath it.  A Slick draft is a frame, not a row: there is nothing
    to strand and nothing to edit.

Authorising a user
    ``extra.allowed_users`` above is only this adapter's own pre-filter — it
    narrows what is forwarded, it never grants access.  The gateway decides
    who may talk to the agent in ``_is_user_authorized``, and for a plugin
    platform that reads the env var named by ``allowed_users_env`` — here
    ``SLICK_ALLOWED_USERS`` — and nothing else.  So::

        SLICK_ALLOWED_USERS=fano      # in ~/.hermes/.env: authorises fano

    Leaving it unset does NOT mean "everyone": with no allowlist anywhere the
    gateway default-denies (SECURITY.md 2.6 forbids failing open) and channel
    messages are dropped in silence.  Setting ``allowed_users`` in config.yaml
    instead looks like it should work and does not.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import sqlite3
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict, deque
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.config import Platform

try:  # pragma: no cover - only importable inside a Hermes checkout
    # Hermes already owns the wording for "what is the agent doing": a verb map
    # (web_search -> "Searching the web") plus the argument preview rules that
    # keep a 4 KB patch out of a one-line label.  Inventing a second vocabulary
    # here would drift from the CLI's the first time a tool is renamed.
    from agent.display import build_status_phrase, build_tool_label
except Exception:  # display is not part of the adapter's contract
    build_status_phrase = None
    build_tool_label = None

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

PLATFORM_NAME = "slick"
PLATFORM_LABEL = "Slick"

DEFAULT_URL = "http://127.0.0.1:4477"
# Listening everywhere is the useful default for a personal workspace: the
# daemon is loopback-only, and a scope that has to be named up front is how a
# renamed channel silently cuts the agent off.
DEFAULT_CHANNEL = "*"
DEFAULT_AGENT_ID = "hermes"
DEFAULT_AGENT_LABEL = "Hermes"

ENV_HOME = "SLICK_HOME"
ENV_URL = "SLICK_URL"
ENV_TOKEN = "SLICK_TOKEN"
ENV_CHANNEL = "SLICK_CHANNEL"
ENV_HOME_CHANNEL = "SLICK_HOME_CHANNEL"
ENV_ALLOWED_USERS = "SLICK_ALLOWED_USERS"
ENV_AGENT_ID = "SLICK_AGENT_ID"
ENV_AGENT_LABEL = "SLICK_AGENT_LABEL"
ENV_REQUEST_TIMEOUT = "SLICK_REQUEST_TIMEOUT"
ENV_STREAM_TIMEOUT = "SLICK_STREAM_TIMEOUT"
ENV_RETRY_SECONDS = "SLICK_RETRY_SECONDS"

# Slick's own per-message cap (packages/core/src/messages.js MAX_TEXT_LENGTH).
MAX_MESSAGE_LENGTH = 40_000

# The metadata key Slick's UI badges a message with, and the gateway event
# that carries the answer.  Underscore-prefixed keys are Slick's own
# bookkeeping namespace: the UI renders them as chrome instead of dumping them
# under the message (apps/web/js/app.js visibleMetadata).
MODEL_METADATA_KEY = "_model"
EFFORT_METADATA_KEY = "_effort"

# Where Hermes writes down what each session resolved to. Read-only, one row,
# and only ever for a badge — see ``session_effort``.
HERMES_STATE_DB = os.path.expanduser(os.environ.get("HERMES_STATE_DB", "~/.hermes/state.db"))
TURN_MODEL_EVENT = "agent:end"
# How many chats to remember a model for.  Read within milliseconds of being
# written in the normal case; bounded because a turn that ends without sending
# (intentional silence, a failed delivery) leaves its entry behind.
MODEL_MEMO_SIZE = 64

# Which Slick thread the turn being handled belongs to.
#
# ``send_typing`` is handed a chat, and Slick hangs its indicator on a thread —
# the gateway has no reason to know the difference, and every platform draws
# this somewhere else.  The inbound message does know, and it is still on the
# stack, so the target rides down in a context variable: a task started for the
# turn copies it at creation and nothing outside that turn can see it.  Two
# threads answered at once therefore never light each other up.
_TURN_TARGET: "contextvars.ContextVar[Optional[Dict[str, str]]]" = contextvars.ContextVar(
    "slick_turn_target", default=None
)

DEFAULT_REQUEST_TIMEOUT = 15.0
# The hub sends ``: keepalive`` every 20s, so a read timeout below that would
# tear down a perfectly healthy stream on every idle minute.
DEFAULT_STREAM_TIMEOUT = 90.0
DEFAULT_RETRY_SECONDS = 2.0
MAX_RETRY_SECONDS = 30.0
# Upper bound on how long ``disconnect()`` waits for the reader task; closing
# the response first is what actually unblocks it, this is the backstop.
DISCONNECT_TIMEOUT = 5.0

# How many event seqs / message ids to remember for de-duplication.  A
# reconnect with Last-Event-ID can legitimately replay the tail of the log,
# and the hub itself re-sends a page boundary on a slow client.
DEDUP_HISTORY = 1024

# Codes for ``_set_fatal_error``, surfaced in ``gateway_state.json`` and
# ``hermes gateway status``.  A reader that gives up has to say why: without
# this the platform still reads as "connected" while nothing can ever arrive.
ERROR_CHANNEL_NOT_FOUND = "channel_not_found"
ERROR_UNAUTHORIZED = "unauthorized"

# The observer hooks a turn fires while it is still running.  All five are in
# hermes_cli/plugins.py VALID_HOOKS; the first three reach us on
# agent/plugin_stream_hooks.py's own daemon thread, the tool pair inline on the
# tool path.  Both callers name the whole set, which is why it lives here
# rather than being spelled out twice.
LIVE_PROGRESS_HOOKS = (
    "on_stream_start",
    "on_stream_delta",
    "on_stream_end",
    "pre_tool_call",
    "post_tool_call",
)

# Which surface a turn is being answered on, as run_agent.py's
# _stream_hook_base_payload spells it.  These hooks fire for every platform
# Hermes serves, so a callback that does not check this would paint a Telegram
# turn's tokens onto a Slick thread.
SURFACE_KEY = "surface"

# How long a delta waits before it goes out.  Each callback gets one daemon
# thread draining a 1024-slot queue that drops its oldest entry when full, so a
# request made inline costs every token that arrives while the socket is open.
# 150ms is slow enough to coalesce a fast model into a few requests a second
# and fast enough that the draft still reads as typing.
DELTA_FLUSH_SECONDS = 0.15
# Ticks of silence before the timer thread retires.  It starts again on the
# next delta; this only stops an idle gateway from waking 7 times a second
# forever after one answered message.
DELTA_IDLE_TICKS = 20
# Ceiling on unsent text for one thread.  Only reachable when the daemon is
# answering slower than the model is writing, and a draft that far behind is
# already wrong — what must not happen is an unbounded buffer inside the
# gateway, so the oldest chunks go first, exactly as the hook queue does it.
DELTA_BUFFER_LIMIT = 64_000

# The thinking blob's phases and the caps normalizeThinking clamps to
# (packages/core/src/thinking.js).  It clamps rather than rejects, so an
# over-long value is not an error — but it truncates from the head, and for a
# reasoning stream the newest words are the half worth keeping, so the trim
# happens here where which end is which is still known.
THINK_STREAMING = "streaming"
THINK_DONE = "done"
THINK_ERROR = "error"
THINK_TITLE_LIMIT = 200
THINK_OUTPUT_LIMIT = 2000
THINK_STEP_LIMIT = 50

# One step id is reserved: the model's own reasoning tokens all land in it, so
# a turn that thinks for a minute is one row that keeps growing rather than
# hundreds.
REASONING_STEP_ID = "reasoning"
REASONING_STEP_TITLE = "Thinking"
# What the box says before anything has happened in it.  A blob with neither a
# title nor a step normalizes to null, so an empty box is not a box.
STREAM_START_TITLE = "Thinking\u2026"

# How many turns' worth of steps to keep.  A turn drops its own on the way
# out; this bounds a gateway that somehow never sees one end.
THINK_LOG_LIMIT = 32

PLATFORM_HINT = (
    "You are chatting in Slick, a local Slack-like workspace. Messages render "
    "as markdown, so fenced code blocks, lists and links all work. Replies to "
    "a threaded message stay in that thread; a reply in a channel starts a new "
    "thread root. Mention people with @name. Keep responses focused — this is "
    "a chat window, not a document."
)


# --------------------------------------------------------------------------
# Config helpers
# --------------------------------------------------------------------------

def _env(name: str, default: str = "") -> str:
    """Read an env var, trimmed.  Missing/blank collapses to ``default``."""
    value = os.getenv(name)
    if value is None:
        return default
    value = value.strip()
    return value if value else default


def _get_secret(name: str, default: str = "") -> str:
    """Scope-aware credential read with an os.environ fallback.

    Secondary gateway profiles construct adapters inside a profile secret
    scope, where ``os.environ`` may hold another profile's value.  The default
    profile constructs *unscoped*, where a bare ``get_secret`` raises — there
    ``os.environ`` is that profile's own value.  Same shape as the IRC and
    WhatsApp adapters; degrades to plain env when the helper is unavailable
    (e.g. running the unit tests outside a Hermes checkout).
    """
    try:
        from agent.secret_scope import UnscopedSecretError, get_secret
    except Exception:
        return _env(name, default)
    try:
        value = get_secret(name, None)
    except UnscopedSecretError:
        value = os.getenv(name)
    except Exception:  # pragma: no cover - defensive: never fail a config read
        value = os.getenv(name)
    if value is None:
        return default
    value = str(value).strip()
    return value if value else default


def _extra(config: Any) -> Dict[str, Any]:
    return dict(getattr(config, "extra", {}) or {})


def daemon_file_path() -> str:
    """Where ``slickd`` publishes itself — mirrors ``paths.js``' rendezvous file."""
    home = _env(ENV_HOME) or os.path.join(os.path.expanduser("~"), ".slick")
    return os.path.join(home, "daemon.json")


def read_daemon_file(path: Optional[str] = None) -> Dict[str, Any]:
    """Whatever the local daemon published about itself, or ``{}``.

    ``slickd`` writes its pid, url and token here on startup; the CLI and the
    desktop shell already read it, so Hermes can too rather than asking the
    operator to keep a second copy of the token in sync.  Unreadable, absent
    or malformed is not an error — a remote daemon has no file on this host
    and every value simply falls back to the configured one.
    """
    try:
        with open(path or daemon_file_path(), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def resolve_url(extra: Optional[Dict[str, Any]] = None) -> str:
    """Base URL of the Slick daemon, without a trailing slash.

    Env, then config, then whatever the local daemon published — which is how
    a workspace on a non-default port works without being told twice.
    """
    raw = _env(ENV_URL) or str((extra or {}).get("url") or "").strip()
    if not raw:
        raw = str(read_daemon_file().get("url") or "").strip()
    return (raw or DEFAULT_URL).rstrip("/") or DEFAULT_URL


def resolve_token(extra: Optional[Dict[str, Any]] = None) -> str:
    """Shared token for ``Authorization: Bearer``, or ``""`` when auth is off.

    Env wins, then config, then ``daemon.json``.  An empty result is a
    perfectly valid configuration and not a failure to report: a workspace
    started with ``--no-auth`` records ``"token": null`` and refuses nothing,
    and :func:`_headers` simply sends no ``Authorization`` header.  A daemon
    that *does* want a token answers 401, which :meth:`SlickAdapter.connect`
    surfaces as a fatal platform error naming the var to set.
    """
    explicit = _get_secret(ENV_TOKEN) or str((extra or {}).get("token") or "").strip()
    if explicit:
        return explicit
    return str(read_daemon_file().get("token") or "").strip()


def resolve_channel(extra: Optional[Dict[str, Any]] = None) -> str:
    """Channel(s) the adapter listens on.  Slug, id, ``*``, or a comma list.

    Defaults to :data:`DEFAULT_CHANNEL` (every channel) rather than to
    nothing, so an unconfigured adapter listens instead of refusing to start.
    """
    return (
        _env(ENV_CHANNEL)
        or str((extra or {}).get("channel") or "").strip()
        or DEFAULT_CHANNEL
    )


# Listen-scope values that mean "every channel in the workspace".
_WILDCARDS = frozenset({"*", "all"})


def resolve_home_channel(extra: Optional[Dict[str, Any]] = None) -> str:
    """Delivery target for cron / notifications.  Defaults to the listen channel."""
    extra = extra or {}
    home = _env(ENV_HOME_CHANNEL) or str(extra.get("home_channel") or "").strip()
    if home:
        return home
    channel = resolve_channel(extra)
    # A wildcard/multi listen scope is not a deliverable target; take the
    # first concrete name so cron still has somewhere to land.
    scope, _ = channel_scope(channel)
    if scope:
        return scope
    names = [part.strip() for part in channel.split(",") if part.strip() and part.strip() not in _WILDCARDS]
    return names[0] if names else ""


def parse_allowed_users(raw: Any) -> frozenset:
    """Normalise an allowlist (string or list) to a lowercase frozenset."""
    if raw is None:
        return frozenset()
    if isinstance(raw, (list, tuple, set, frozenset)):
        parts: List[str] = [str(item) for item in raw]
    else:
        parts = str(raw).replace("\n", ",").split(",")
    return frozenset(part.strip().lower() for part in parts if str(part).strip())


def resolve_allowed_users(extra: Optional[Dict[str, Any]] = None) -> frozenset:
    raw = _env(ENV_ALLOWED_USERS) or (extra or {}).get("allowed_users")
    return parse_allowed_users(raw)


def channel_scope(channel: Any) -> Tuple[Optional[str], Optional[frozenset]]:
    """Split the configured channel into (server-side scope, client filter).

    ``GET /api/stream`` takes a single ``?channel=`` ref, so one channel is
    filtered by the daemon.  ``*`` subscribes to everything, and a comma list
    subscribes to everything and filters here.  The client-side set is kept
    even in the single-channel case: it costs nothing and means a server that
    ignores the query param can never leak another channel into the agent.
    """
    value = str(channel or "").strip()
    if not value or value.lower() in _WILDCARDS:
        return None, None
    names = [part.strip() for part in value.split(",") if part.strip()]
    if not names:
        return None, None
    allowed = frozenset(name.lower() for name in names)
    if len(names) == 1:
        return names[0], allowed
    return None, allowed


def _number_setting(
    extra: Optional[Dict[str, Any]], key: str, env_name: str, default: float
) -> float:
    raw = _env(env_name) or (extra or {}).get(key)
    try:
        value = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _redact(text: Any, token: Optional[str] = None) -> str:
    """Strip the shared token out of anything user- or log-facing."""
    out = str(text)
    for secret in (token, os.getenv(ENV_TOKEN)):
        if secret and len(str(secret)) >= 4:
            out = out.replace(str(secret), "***")
    return out


# --------------------------------------------------------------------------
# HTTP plumbing (blocking; always called through asyncio.to_thread)
# --------------------------------------------------------------------------

class SlickApiError(Exception):
    """A Slick REST call failed.  ``message`` is safe to log — no token."""

    def __init__(
        self,
        message: str,
        status: Optional[int] = None,
        retryable: bool = False,
        payload: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.retryable = retryable
        self.payload = payload


def _safe_json(text: Any) -> Any:
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def _describe_http_error(status: int, body: str, token: Optional[str]) -> str:
    """Turn Slick's ``{"error": {...}}`` envelope into one readable line."""
    parsed = _safe_json(body)
    detail = ""
    if isinstance(parsed, dict):
        error = parsed.get("error")
        if isinstance(error, dict):
            code = str(error.get("code") or "").strip()
            message = str(error.get("message") or "").strip()
            detail = " ".join(part for part in (code, message) if part)
        elif error:
            detail = str(error)
    if not detail:
        detail = (body or "").strip()[:200]
    return _redact("Slick API {}{}".format(status, ": " + detail if detail else ""), token)


def _headers(token: Optional[str], extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    headers = {"accept": "application/json"}
    if token:
        headers["authorization"] = "Bearer {}".format(token)
    if extra:
        headers.update(extra)
    return headers


def api_request(
    method: str,
    url: str,
    token: Optional[str],
    payload: Optional[Dict[str, Any]] = None,
    timeout: float = DEFAULT_REQUEST_TIMEOUT,
) -> Tuple[int, Any]:
    """Blocking JSON request.  Raises :class:`SlickApiError` on any failure.

    5xx, 429 and transport errors are marked ``retryable`` — everything else
    (401, 404, 409, 422) is a configuration or content problem that retrying
    would only repeat.
    """
    data = None
    headers = _headers(token)
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(response.getcode() or 0)
            body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8", "replace")
        except Exception:
            raw = ""
        status = int(getattr(exc, "code", 0) or 0)
        raise SlickApiError(
            _describe_http_error(status, raw, token),
            status=status,
            retryable=status >= 500 or status == 429,
            payload=_safe_json(raw),
        )
    except (urllib.error.URLError, OSError) as exc:
        raise SlickApiError(
            _redact("Slick is unreachable at {}: {}".format(_origin(url), exc), token),
            status=None,
            retryable=True,
        )
    parsed = _safe_json(body)
    if parsed is None:
        raise SlickApiError(
            "Slick returned a non-JSON response ({})".format(status), status=status
        )
    return status, parsed


def _origin(url: str) -> str:
    """Scheme + host of a URL — never carries credentials, safe to log."""
    try:
        parts = urllib.parse.urlsplit(url)
        return "{}://{}".format(parts.scheme, parts.netloc)
    except Exception:  # pragma: no cover - defensive
        return "the Slick daemon"


def build_send_request(
    base_url: str,
    chat_id: Optional[str],
    text: str,
    thread_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    author: Optional[Dict[str, Any]] = None,
) -> Tuple[str, Dict[str, Any]]:
    """Return the (url, body) for a Slick post.

    A thread id routes to the reply endpoint; anything else posts a new root
    message into the channel.  Pure — the tests assert both shapes without a
    socket in sight.
    """
    base = str(base_url or "").rstrip("/")
    if thread_id:
        url = "{}/api/messages/{}/replies".format(base, urllib.parse.quote(str(thread_id), safe=""))
    else:
        ref = str(chat_id or "")
        url = "{}/api/channels/{}/messages".format(base, urllib.parse.quote(ref, safe=""))
    body: Dict[str, Any] = {"text": text, "metadata": json_safe_metadata(metadata)}
    if author:
        body["author"] = author
    return url, body


def json_safe_metadata(metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Provenance plus whatever of the caller's metadata survives JSON.

    ``send()`` metadata is gateway-internal and may hold adapters, futures or
    other unserialisable objects; those are dropped rather than failing the
    send.
    """
    safe: Dict[str, Any] = {"_via": "hermes"}
    if isinstance(metadata, dict):
        for key, value in list(metadata.items())[:32]:
            coerced = _json_safe(value, 0)
            if coerced is not _DROP:
                name = str(key)
                safe[name if name.startswith("_") else "_" + name] = coerced
    return safe


_DROP = object()


def _json_safe(value: Any, depth: int) -> Any:
    if value is None or isinstance(value, bool) or isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        return value[:2000]
    if depth >= 3:
        return _DROP
    if isinstance(value, (list, tuple)):
        out = [_json_safe(item, depth + 1) for item in value[:32]]
        return [item for item in out if item is not _DROP]
    if isinstance(value, dict):
        result = {}
        for key, item in list(value.items())[:32]:
            coerced = _json_safe(item, depth + 1)
            if coerced is not _DROP:
                result[str(key)] = coerced
        return result
    return _DROP


def post_message_sync(
    base_url: str,
    token: Optional[str],
    chat_id: Optional[str],
    text: str,
    thread_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    author: Optional[Dict[str, Any]] = None,
    timeout: float = DEFAULT_REQUEST_TIMEOUT,
) -> Dict[str, Any]:
    """Post one message and return the decoded ``{"message": {...}}`` body."""
    url, body = build_send_request(base_url, chat_id, text, thread_id, metadata, author)
    _, data = api_request("POST", url, token, payload=body, timeout=timeout)
    return data if isinstance(data, dict) else {}


def stream_url(base_url: str, scope: Optional[str] = None) -> str:
    url = "{}/api/stream".format(str(base_url or "").rstrip("/"))
    if scope:
        url = "{}?{}".format(url, urllib.parse.urlencode({"channel": scope}))
    return url


def open_stream_sync(
    url: str,
    token: Optional[str],
    last_event_id: Optional[str] = None,
    timeout: float = DEFAULT_STREAM_TIMEOUT,
):
    """Open the SSE stream.  Blocking; the caller owns closing the response."""
    headers = _headers(token, {"accept": "text/event-stream", "cache-control": "no-store"})
    if last_event_id:
        # Set automatically by browser EventSource; we are our own client, so
        # we have to carry the cursor ourselves.  The hub replays every event
        # after this seq, so an outage costs latency and not messages.
        headers["last-event-id"] = str(last_event_id)
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8", "replace")
        except Exception:
            raw = ""
        status = int(getattr(exc, "code", 0) or 0)
        raise SlickApiError(
            _describe_http_error(status, raw, token),
            status=status,
            retryable=status >= 500 or status == 429,
        )
    except (urllib.error.URLError, OSError) as exc:
        raise SlickApiError(
            _redact("Slick stream unreachable at {}: {}".format(_origin(url), exc), token),
            retryable=True,
        )


# --------------------------------------------------------------------------
# Server-Sent Events
# --------------------------------------------------------------------------

class SSEParser:
    """Incremental parser for the SSE wire format.

    Line in, event out: ``feed_line`` returns ``None`` until a blank line
    closes a block, then yields ``{"event", "id", "data", "json"}``.  Comment
    lines (the hub's ``: keepalive``) and blocks with no ``data`` field are
    dropped, per the spec.  ``last_event_id`` is sticky across events — it is
    what a reconnect resumes from.
    """

    def __init__(self) -> None:
        self._data: List[str] = []
        self._event: Optional[str] = None
        self._id: Optional[str] = None
        self.retry: Optional[float] = None
        self.last_event_id: Optional[str] = None

    def feed_line(self, line: str) -> Optional[Dict[str, Any]]:
        text = str(line)
        if text.endswith("\n"):
            text = text[:-1]
        if text.endswith("\r"):
            text = text[:-1]
        if text == "":
            return self._dispatch()
        if text.startswith(":"):
            return None
        field, sep, value = text.partition(":")
        if not sep:
            field, value = text, ""
        if value.startswith(" "):
            value = value[1:]
        if field == "data":
            self._data.append(value)
        elif field == "event":
            self._event = value
        elif field == "id":
            if "\x00" not in value:
                self._id = value
        elif field == "retry":
            try:
                self.retry = int(value) / 1000.0
            except ValueError:
                pass
        return None

    def feed(self, chunk: str) -> List[Dict[str, Any]]:
        """Feed a whole buffer; return every complete event it contained."""
        events: List[Dict[str, Any]] = []
        for line in str(chunk).splitlines():
            event = self.feed_line(line)
            if event is not None:
                events.append(event)
        return events

    def _dispatch(self) -> Optional[Dict[str, Any]]:
        if not self._data:
            self._event = None
            self._id = None
            return None
        payload = "\n".join(self._data)
        event = {
            "event": self._event or "message",
            "id": self._id,
            "data": payload,
            "json": _safe_json(payload),
        }
        if self._id is not None:
            self.last_event_id = self._id
        self._data = []
        self._event = None
        self._id = None
        return event


class _BoundedSet:
    """Membership test with a fixed memory ceiling (FIFO eviction)."""

    def __init__(self, limit: int = DEDUP_HISTORY) -> None:
        self.limit = max(1, int(limit))
        self._items: set = set()
        self._order: deque = deque()

    def __contains__(self, item: Any) -> bool:
        return item in self._items

    def __len__(self) -> int:
        return len(self._items)

    def add(self, item: Any) -> bool:
        """Add ``item``; return False when it was already present."""
        if item in self._items:
            return False
        self._items.add(item)
        self._order.append(item)
        while len(self._order) > self.limit:
            self._items.discard(self._order.popleft())
        return True


def session_effort(session_id: Any) -> str:
    """How hard Hermes was told to think, out of its own session record.

    The gateway's ``agent:end`` names the model but not the level, and reading
    the level out of config instead would be a badge that lies the moment the
    setting moves.  Hermes resolves it once, when a session is created, and
    writes it into that session's row — so for a thread, whose session is its
    own, that row is the honest answer.

    Never raises and never waits long: a badge is a nicety, and a locked or
    missing store is not a reason to hold up a reply.
    """
    key = str(session_id or "").strip()
    if not key or not os.path.isfile(HERMES_STATE_DB):
        return ""
    try:
        with sqlite3.connect(
            "file:{}?mode=ro".format(urllib.parse.quote(HERMES_STATE_DB)), uri=True, timeout=2
        ) as store:
            row = store.execute(
                "SELECT json_extract(model_config, '$.reasoning_config.effort') "
                "FROM sessions WHERE id = ?",
                (key,),
            ).fetchone()
    except (OSError, sqlite3.Error):
        return ""
    return str(row[0]).strip() if row and row[0] else ""


def memo_key(chat_id: Any, thread_id: Any) -> str:
    """The memo slot one turn owns.

    Keyed on the pair, never the chat alone.  Two threads of one channel can
    be answered at the same time, and with a chat-keyed slot whichever turn
    ended second overwrote the first — so the reply that went out last could
    be badged with the model that answered the other question.  The typing
    indicator has been per-thread since it was written; the badge was the half
    that was not.
    """
    chat = str(chat_id or "").strip()
    thread = str(thread_id or "").strip()
    if not chat and not thread:
        return ""
    # Unit separator: a channel slug or a message id can hold neither, so no
    # pair can be spelled two ways.
    return "{}\x1f{}".format(chat, thread)


class _ModelMemo:
    """A bounded ``turn -> model`` memo, newest wins.

    Not an LRU: reads do not renew an entry, because the useful lifetime is
    one turn.  Eviction only exists so a long-lived gateway cannot accumulate
    an entry per channel it ever answered in.
    """

    def __init__(self, limit: int = MODEL_MEMO_SIZE) -> None:
        self._items: "OrderedDict[str, str]" = OrderedDict()
        self._limit = max(1, int(limit))

    def __len__(self) -> int:
        return len(self._items)

    def put(self, key: str, value: str) -> None:
        key = str(key or "").strip()
        value = str(value or "").strip()
        if not key or not value:
            return
        self._items[key] = value
        self._items.move_to_end(key)
        while len(self._items) > self._limit:
            self._items.popitem(last=False)

    def get(self, *keys: Any) -> Optional[str]:
        """First key that has a model, so a caller can try exact then coarser."""
        for key in keys:
            found = self._items.get(str(key or "").strip())
            if found:
                return found
        return None


def normalise_model(value: Any) -> str:
    """What to badge a message with.

    Verbatim, with one concession to a chat window: a model identified by a
    filesystem path (a local GGUF, say) badges as its basename.  Still true,
    and a 90-character absolute path is not a badge.  Separators are handled
    for both platforms because the id comes from whichever host runs the
    provider, not from this one.
    """
    text = str(value or "").strip()
    if not text:
        return ""
    for separator in ("/", "\\"):
        if separator in text:
            text = text.rsplit(separator, 1)[-1].strip() or text
    return text


def _timestamp(value: Any) -> datetime:
    """Slick stamps epoch milliseconds; fall back to now for anything else."""
    try:
        return datetime.fromtimestamp(float(value) / 1000.0)
    except (TypeError, ValueError, OSError, OverflowError):
        return datetime.now()


# --------------------------------------------------------------------------
# Live progress
# --------------------------------------------------------------------------

def _tail(value: Any, limit: int) -> str:
    """Trim to ``limit`` characters, keeping the end.

    Slick's own clamp keeps the beginning, which is right for a title and
    wrong for a reasoning stream — nobody wants the first paragraph of a
    thought that has moved on twice since.
    """
    text = str(value or "")
    if len(text) <= limit:
        return text
    return "…" + text[-(limit - 1):]


def step_title(tool_name: Any, args: Any) -> str:
    """How a tool call reads in the box.

    Hermes' own label first, because that is what the CLI shows for the same
    call.  ``build_status_phrase`` is written to trail a display name ("Hermes
    is running tests.sh"), so when it is the only one left the leading "is"
    comes off — the step sits under the agent's name already.  With neither
    available the raw tool name is still true, which is the whole point of
    guarding the import.
    """
    name = str(tool_name or "").strip()
    label = None
    if build_tool_label is not None:
        try:
            label = build_tool_label(name, args if isinstance(args, dict) else {}, max_len=120)
        except Exception:  # pragma: no cover - defensive
            label = None
    if not label and build_status_phrase is not None:
        try:
            phrase = build_status_phrase(name, args if isinstance(args, dict) else {})
        except Exception:  # pragma: no cover - defensive
            phrase = None
        if phrase:
            label = phrase[3:] if phrase.startswith("is ") else phrase
            label = label.strip()
            if label:
                label = label[0].upper() + label[1:]
    label = str(label or name or "tool").strip()
    return label[:THINK_TITLE_LIMIT]


class _ThinkLog:
    """One turn's thinking blob, grown a step at a time.

    The wire shape is Slick's (``packages/core/src/thinking.js``): short keys,
    because the blob is embedded whole in every hydrated frame for that message
    for as long as the message exists.  Steps are id-keyed and append-only, so
    a tool that finishes updates its own row instead of adding a second one —
    that is what lets the box redraw without the list jumping under the cursor.
    """

    def __init__(self) -> None:
        self._steps: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._title = ""
        self._phase = THINK_STREAMING
        self._reasoning = ""
        # Two clocks, and this is the slow one.  Every push of the blob appends
        # a durable row to Slick's event log, so the blob is only worth pushing
        # when its *shape* moved — a step opened, settled or was renamed.  A
        # reasoning token rewrites the same step's output several times a
        # second and buys no row at all; it goes out with the next transition,
        # which ``on_stream_end`` always supplies.
        self._rev = 0
        self._pushed = 0

    def __len__(self) -> int:
        return len(self._steps)

    def steps_moved(self) -> bool:
        """True once for each change to the step set since it was last asked."""
        if self._rev == self._pushed:
            return False
        self._pushed = self._rev
        return True

    def title(self, text: Any) -> None:
        """Name the box, but never over the top of a step that is running."""
        if not self._title:
            self._title = str(text or "")[:THINK_TITLE_LIMIT]
            # A box that has just been given its first name is a box that was
            # not on screen a moment ago, which is worth saying at once.
            self._rev += 1

    def phase(self, phase: str) -> None:
        self._phase = phase

    def step(
        self,
        step_id: Any,
        title: Any = None,
        status: Optional[str] = None,
        output: Any = None,
    ) -> None:
        key = str(step_id or "").strip() or "s{}".format(len(self._steps))
        row = self._steps.get(key)
        if row is None:
            if len(self._steps) >= THINK_STEP_LIMIT:
                # Slick drops steps from the tail once a blob passes fifty, so
                # a fifty-first would be built here and thrown away there.
                return
            row = {"id": key}
            self._steps[key] = row
            self._rev += 1
        if title:
            named = str(title)[:THINK_TITLE_LIMIT]
            if row.get("t") != named:
                row["t"] = named
                self._rev += 1
        if status:
            if row.get("st") != status:
                self._rev += 1
            row["st"] = status
        if output:
            # Deliberately no revision: this is the one field that moves at
            # token rate, and a row in the event log per token is what these
            # two clocks exist to prevent.
            row["o"] = _tail(output, THINK_OUTPUT_LIMIT)
        # The collapsed line follows the most recent step, finished or not: a
        # box whose last tool has come back should read "Read paths.js" rather
        # than keep claiming it is still reading, and going blank instead would
        # lose the only summary a collapsed box has.
        if row.get("t"):
            self._title = row["t"]

    def reason(self, delta: Any) -> None:
        """Fold a reasoning token into the one step they all share."""
        self._reasoning = _tail(self._reasoning + str(delta or ""), THINK_OUTPUT_LIMIT)
        self.step(
            REASONING_STEP_ID,
            title=REASONING_STEP_TITLE,
            status="in_progress",
            output=self._reasoning,
        )

    def finish_reasoning(self) -> None:
        """Close the reasoning step if there is one; never open one."""
        row = self._steps.get(REASONING_STEP_ID)
        if row is not None and row.get("st") != "complete":
            row["st"] = "complete"
            # Which is also when everything reasoned since the step opened
            # finally rides out, on the back of the transition.
            self._rev += 1

    def settle(self, phase: str) -> None:
        """Put the box down: no step is allowed to outlive the turn spinning.

        The web renderer coerces stragglers too, but a blob can also be read
        straight off ``GET /api/thinking``, and a snapshot that says a tool is
        still running an hour after the answer landed is simply wrong.
        """
        self._phase = phase
        settled = THINK_ERROR if phase == THINK_ERROR else "complete"
        for row in self._steps.values():
            if row.get("st") in (None, "pending", "in_progress"):
                row["st"] = settled
        self._rev += 1

    def blob(self) -> Dict[str, Any]:
        return {
            "t": self._title[:THINK_TITLE_LIMIT],
            "p": self._phase,
            "s": [dict(row) for row in self._steps.values()],
        }


class _DeltaFlusher:
    """Coalesces one thread's live progress into one request per tick.

    ``push`` is called from the observer's dispatcher thread — the only thread
    draining that hook's bounded queue — and from the tool path itself, which
    the model is waiting on.  Both must get it back immediately, so push only
    appends under a lock held for the length of a list append, and a single
    daemon thread does all the talking.

    ``deliver(thread_id, text, think, done)`` is called once per thread per
    tick, off the caller's thread, with everything that accumulated since the
    last one.
    """

    def __init__(self, deliver: Any, interval: float = DELTA_FLUSH_SECONDS) -> None:
        self._deliver = deliver
        self._interval = max(0.01, float(interval))
        self._lock = threading.Lock()
        self._pending: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._stopping = False

    def push(
        self,
        thread_id: Any,
        text: Any = None,
        think: Optional[Dict[str, Any]] = None,
        done: bool = False,
    ) -> None:
        key = str(thread_id or "")
        if not key:
            return
        with self._lock:
            slot = self._pending.get(key)
            if slot is None:
                slot = {"text": [], "size": 0, "think": None, "done": False}
                self._pending[key] = slot
            if text:
                slot["text"].append(str(text))
                slot["size"] += len(str(text))
                while slot["size"] > DELTA_BUFFER_LIMIT and len(slot["text"]) > 1:
                    slot["size"] -= len(slot["text"].pop(0))
            if think is not None:
                # The blob is cumulative, so the newest one says everything the
                # ones it replaces did.
                slot["think"] = think
            if done:
                slot["done"] = True
        self._start()

    def flush(self) -> None:
        """Send everything buffered.  Runs on the timer thread, and in tests."""
        with self._lock:
            pending, self._pending = self._pending, OrderedDict()
        for thread_id, slot in pending.items():
            try:
                self._deliver(thread_id, "".join(slot["text"]), slot["think"], slot["done"])
            except Exception:  # pragma: no cover - defensive
                logger.debug(
                    "Slick: live progress for %s did not go out", thread_id, exc_info=True
                )

    def close(self) -> None:
        """Stop the timer thread and send what is left; a push starts it again."""
        with self._lock:
            thread, self._thread = self._thread, None
            self._stopping = True
        self._wake.set()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        with self._lock:
            self._stopping = False
        self.flush()

    def _start(self) -> None:
        with self._lock:
            if self._stopping:
                return
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(
                target=self._run, name="slick-delta-flusher", daemon=True
            )
            self._thread.start()

    def _run(self) -> None:
        idle = 0
        while True:
            self._wake.wait(self._interval)
            self._wake.clear()
            self.flush()
            with self._lock:
                if self._stopping:
                    return
                if self._pending:
                    idle = 0
                    continue
                idle += 1
                if idle >= DELTA_IDLE_TICKS:
                    # Retiring under the lock is what lets a concurrent push
                    # see a dead thread and start a live one.
                    self._thread = None
                    return


class _StreamBridge:
    """Relays a turn's live progress from Hermes' observer hooks to Slick.

    The hooks are process-wide and are registered before any adapter exists,
    so this is a module singleton the live adapter lends its url, token and
    agent id to when it connects.  With nothing attached it still resolves an
    endpoint the way every other entry point in this file does — daemon.json,
    then env — so a host that registers plugins without ever connecting a
    platform is not a silent hole.

    Nothing here is allowed to raise into the agent.  A thinking box is a
    nicety; the answer is not.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._adapter: Optional[Any] = None
        self._logs: "OrderedDict[str, _ThinkLog]" = OrderedDict()
        self._live: "OrderedDict[str, Dict[str, str]]" = OrderedDict()
        self._hooks: Optional[Tuple[Tuple[str, Any], ...]] = None
        # Routes a workspace turns out not to have.  An older daemon would
        # otherwise be asked for one that does not exist every 150ms, forever.
        self._missing: set = set()
        self._flusher = _DeltaFlusher(self._deliver)

    # -- wiring ------------------------------------------------------------

    def hooks(self) -> Tuple[Tuple[str, Any], ...]:
        """The ``(name, callback)`` pairs to register, built exactly once.

        ``agent/plugin_stream_hooks.py`` keys a callback's dispatcher on
        ``id(callback)``, and a bound method is a fresh object every time it is
        read off the instance — so handing out a new one per call would leave a
        dispatcher thread behind on every registration.
        """
        if self._hooks is None:
            self._hooks = tuple(
                (name, getattr(self, name)) for name in LIVE_PROGRESS_HOOKS
            )
        return self._hooks

    def attach(self, adapter: Any) -> None:
        """Answer with this workspace's url, token and agent id from now on."""
        with self._lock:
            self._adapter = adapter

    def detach(self, adapter: Any) -> None:
        """Let go of a workspace that is disconnecting, and send the tail."""
        with self._lock:
            if self._adapter is not adapter:
                return
            self._adapter = None
            self._logs.clear()
            self._live.clear()
        self._flusher.close()

    # -- turn bookkeeping --------------------------------------------------

    def turn_started(self, target: Dict[str, str]) -> None:
        """Note a turn as live, for deltas that arrive without its context."""
        thread_id = str((target or {}).get("thread_id") or "")
        if not thread_id:
            return
        with self._lock:
            self._live[thread_id] = dict(target)

    def turn_finished(self, target: Dict[str, str], failed: bool = False) -> None:
        """The turn is over: settle its box so nothing is left spinning.

        How it ended decides what the stragglers become.  A turn that raised
        stopped somewhere inside one of these steps, and calling that step
        complete would caption the box "Finished thinking" over the exact
        moment a reader needs to look at — so a failed turn settles on
        ``error``, which is the one phase the box opens itself for.
        """
        thread_id = str((target or {}).get("thread_id") or "")
        if not thread_id:
            return
        with self._lock:
            self._live.pop(thread_id, None)
            log = self._logs.pop(thread_id, None)
        if log is None:
            # Nothing ever drew a box for this turn — a workspace with no
            # streaming producer must cost exactly no requests.
            return
        log.settle(THINK_ERROR if failed else THINK_DONE)
        # Pushed, not flushed: this runs on the gateway's event loop, and the
        # timer thread is a hundred and fifty milliseconds away.
        self._flusher.push(thread_id, think=log.blob(), done=True)

    # -- hooks -------------------------------------------------------------

    def on_stream_start(self, **payload: Any) -> None:
        """A model call began.  Draw the box before there is anything in it."""
        thread_id = self._stream_thread(payload)
        if not thread_id:
            return
        log = self._log(thread_id)
        log.phase(THINK_STREAMING)
        log.title(STREAM_START_TITLE)
        self._push_steps(thread_id, log)

    def on_stream_delta(self, **payload: Any) -> None:
        """One token.  Buffer it and get off this thread."""
        thread_id = self._stream_thread(payload)
        if not thread_id:
            return
        delta = payload.get("delta")
        if not isinstance(delta, str) or not delta:
            return
        if str(payload.get("kind") or "text") == "reasoning":
            # Only ever arrives when plugins.stream_reasoning_deltas is on;
            # answer text and reasoning must never share a buffer, because one
            # of them is the draft reply and the other is emphatically not.
            log = self._log(thread_id)
            log.reason(delta)
            self._push_steps(thread_id, log)
            return
        self._flusher.push(thread_id, text=delta)

    def on_stream_end(self, **payload: Any) -> None:
        """A model call finished — which is not the same as the turn finishing.

        A turn that calls tools runs several streams, so settling here would
        put the box down between iterations and pick it up again.  ``done``
        belongs to :meth:`turn_finished`; this only closes the reasoning step.
        """
        thread_id = self._stream_thread(payload)
        if not thread_id:
            return
        with self._lock:
            log = self._logs.get(thread_id)
        if log is None:
            return
        log.finish_reasoning()
        self._push_steps(thread_id, log)

    def pre_tool_call(self, **payload: Any) -> None:
        """A tool is about to run: open a step for it."""
        thread_id = self._tool_thread(payload)
        tool_name = str(payload.get("tool_name") or "")
        if not thread_id or not tool_name:
            return
        log = self._log(thread_id)
        log.step(
            self._step_id(payload),
            # Present progressive while it runs, per Slick's copy rules; the
            # ellipsis is U+2026 and comes off again when the step completes.
            title=step_title(tool_name, payload.get("args")) + "…",
            status="in_progress",
        )
        self._push_steps(thread_id, log)
        # Returns None deliberately: a dict from this hook is a directive that
        # can block the tool call, and an observer must never veto one.

    def post_tool_call(self, **payload: Any) -> None:
        """The tool is done: close its step, and say so if it failed."""
        thread_id = self._tool_thread(payload)
        tool_name = str(payload.get("tool_name") or "")
        if not thread_id or not tool_name:
            return
        failed = str(payload.get("status") or "").lower() == "error"
        log = self._log(thread_id)
        log.step(
            self._step_id(payload),
            # Hermes' verb map is present-progressive only, so a finished step
            # drops the ellipsis rather than inventing a past tense the map
            # cannot supply.
            title=step_title(tool_name, payload.get("args")),
            status=THINK_ERROR if failed else "complete",
            output=payload.get("error_message") if failed else None,
        )
        self._push_steps(thread_id, log)

    # -- routing -----------------------------------------------------------

    def _stream_thread(self, payload: Dict[str, Any]) -> Optional[str]:
        """Which Slick thread a streamed token belongs to, or None."""
        if str(payload.get(SURFACE_KEY) or "") != PLATFORM_NAME:
            return None
        thread_id = str((_TURN_TARGET.get() or {}).get("thread_id") or "")
        if thread_id:
            return thread_id
        # A stream delta reaches us on the observer's own daemon thread, which
        # was started long before this turn and carries none of its context.
        # The payload names the surface but not the thread, so the only honest
        # answer left is the turn itself — and only while there is exactly one,
        # because a draft in the wrong thread is worse than no draft at all.
        with self._lock:
            if len(self._live) != 1:
                return None
            return next(iter(self._live))

    def _tool_thread(self, payload: Dict[str, Any]) -> Optional[str]:
        """Which Slick thread a tool call belongs to, or None.

        These two are the hooks here that carry no ``surface``: ``model_tools``
        fires them inline on the tool path and does not know which platform
        asked.  Filtering them on ``payload["surface"] == "slick"`` the way the
        three stream hooks do — which is what the written contract asks for —
        would therefore drop every tool step there has ever been, so this is a
        deliberate divergence and not an oversight: what they do run inside is
        the turn's own context, copied into the agent worker thread, so the
        context variable is the router and the surface test at once, and a CLI
        turn's worker thread simply has none.  If Hermes ever starts sending a
        surface on these, the check below honours it.
        The single-live-turn fallback the deltas lean on is deliberately not
        reused here: without a surface to check it could hand another
        platform's tool call to a Slick thread.
        """
        surface = payload.get(SURFACE_KEY)
        if surface and str(surface) != PLATFORM_NAME:
            return None
        return str((_TURN_TARGET.get() or {}).get("thread_id") or "") or None

    @staticmethod
    def _step_id(payload: Dict[str, Any]) -> str:
        """One id per tool call, so pre and post land on the same row."""
        return str(payload.get("tool_call_id") or "").strip() or "{}:{}".format(
            payload.get("turn_id") or "", payload.get("tool_name") or ""
        )

    def _log(self, thread_id: str) -> _ThinkLog:
        with self._lock:
            log = self._logs.get(thread_id)
            if log is None:
                log = _ThinkLog()
                self._logs[thread_id] = log
                while len(self._logs) > THINK_LOG_LIMIT:
                    self._logs.popitem(last=False)
            return log

    def _push_steps(self, thread_id: str, log: _ThinkLog) -> None:
        """Queue the blob, but only if the step set actually moved.

        The two routes are not the same kind of thing and do not share a clock.
        ``/api/stream/delta`` writes nothing down, so the flusher's 150ms tick
        is the right rate for it: a frame more or less costs a redraw.
        ``/api/thinking`` appends a row to the event log that outlives the turn
        by as long as the workspace exists, so it is spent on transitions —
        a step opening, settling, or being renamed as it finishes — and never
        on the mere arrival of more characters.

        Still queued rather than posted: a tool call is waiting on this thread.
        """
        if log.steps_moved():
            self._flusher.push(thread_id, think=log.blob())

    # -- delivery ----------------------------------------------------------

    def _endpoint(self) -> Tuple[str, str, str, float]:
        with self._lock:
            live = self._adapter
        if live is not None:
            return (live.base_url, live._token, live.agent_id, live.request_timeout)
        return (
            resolve_url(),
            resolve_token(),
            _env(ENV_AGENT_ID) or DEFAULT_AGENT_ID,
            DEFAULT_REQUEST_TIMEOUT,
        )

    def _deliver(self, thread_id: str, text: str, think: Optional[Dict[str, Any]], done: bool) -> None:
        base_url, token, agent_id, timeout = self._endpoint()
        if not base_url or not agent_id:
            return
        if think is not None:
            self._post(
                base_url,
                "/api/thinking",
                token,
                {"agentId": agent_id, "threadId": thread_id, "think": think},
                timeout,
            )
        if not text and not done:
            return
        body: Dict[str, Any] = {"agentId": agent_id, "threadId": thread_id}
        if text:
            body["text"] = text
        if done:
            body["done"] = True
        self._post(base_url, "/api/stream/delta", token, body, timeout)

    def _post(
        self,
        base_url: str,
        path: str,
        token: str,
        payload: Dict[str, Any],
        timeout: float,
    ) -> None:
        if path in self._missing:
            return
        try:
            api_request("POST", base_url + path, token, payload, timeout)
        except SlickApiError as exc:
            if exc.status == 404:
                # A workspace older than these routes answers 404 to every one
                # of them; asking again on the next tick would be the same
                # question at seven times a second for the life of the gateway.
                self._missing.add(path)
                logger.info(
                    "Slick: %s is not served by this workspace — live progress is off", path
                )
                return
            logger.debug("Slick: %s failed (%s)", path, exc.message)
        except Exception:  # pragma: no cover - defensive
            logger.debug("Slick: %s failed", path, exc_info=True)


# One workspace per gateway process, and the hooks are registered before any
# adapter is built — see _StreamBridge.
_STREAM_BRIDGE = _StreamBridge()


# --------------------------------------------------------------------------
# Adapter
# --------------------------------------------------------------------------

class SlickAdapter(BasePlatformAdapter):
    """Bridges a Slick workspace to the Hermes gateway."""

    # Slick renders messages with markdown-it, fences included.
    supports_code_blocks = True
    supports_async_delivery = True

    def __init__(self, config: Any) -> None:
        super().__init__(config, Platform(PLATFORM_NAME))

        extra = _extra(config)
        token_from_config = getattr(config, "token", None)
        if token_from_config and not extra.get("token"):
            extra["token"] = token_from_config
        self.extra = extra

        self.base_url = resolve_url(extra)
        self._token = resolve_token(extra)
        self.channel = resolve_channel(extra)
        self.home_channel = resolve_home_channel(extra)
        self.scope, self.channel_filter = channel_scope(self.channel)
        self.allowed_users = resolve_allowed_users(extra)
        self.agent_id = _env(ENV_AGENT_ID) or str(extra.get("agent_id") or "") or DEFAULT_AGENT_ID
        self.agent_label = (
            _env(ENV_AGENT_LABEL) or str(extra.get("agent_label") or "") or DEFAULT_AGENT_LABEL
        )

        self.request_timeout = _number_setting(
            extra, "request_timeout", ENV_REQUEST_TIMEOUT, DEFAULT_REQUEST_TIMEOUT
        )
        self.stream_timeout = _number_setting(
            extra, "stream_timeout", ENV_STREAM_TIMEOUT, DEFAULT_STREAM_TIMEOUT
        )
        self.retry_seconds = _number_setting(
            extra, "retry_seconds", ENV_RETRY_SECONDS, DEFAULT_RETRY_SECONDS
        )

        self._stream_task: Optional[asyncio.Task] = None
        self._stream_response: Any = None
        self._closing = False
        self._last_event_id: Optional[str] = None
        self._seen_event_seqs = _BoundedSet()
        self._seen_message_ids = _BoundedSet()
        # Ids Hermes itself wrote.  author.kind already keeps our own replies
        # out, but a workspace configured to post Hermes as a human would
        # otherwise loop, and this makes that impossible.
        self._own_message_ids = _BoundedSet()
        self._channel_kinds: Dict[str, str] = {}
        # What answered the turn now being delivered, per chat — see
        # _subscribe_to_turn_model.
        self._turn_models = _ModelMemo()
        self._turn_efforts = _ModelMemo()
        self._turn_model_hooked = False

    # -- lifecycle ---------------------------------------------------------

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        """Start tailing the workspace stream in the background."""
        # Neither a token nor a channel is required: an unauthenticated
        # workspace has no token to give, and the listen scope defaults to
        # every channel.  What cannot be papered over is a daemon that wants
        # credentials we do not have — that surfaces below as a 401.
        self._closing = False
        try:
            health = await asyncio.to_thread(
                api_request,
                "GET",
                "{}/api/health".format(self.base_url),
                self._token,
                None,
                self.request_timeout,
            )
            info = health[1] if isinstance(health, tuple) else {}
            logger.info(
                "Slick: connected to %s (workspace=%s, version=%s)",
                _origin(self.base_url),
                (info or {}).get("workspace"),
                (info or {}).get("version"),
            )
        except SlickApiError as exc:
            if exc.status in (401, 403):
                # Retrying cannot fix a missing or wrong token; fail loudly and
                # say which knob fixes it, since the token is normally picked
                # up from daemon.json and never configured by hand.
                logger.error(
                    "Slick: %s — set %s (or start the daemon with --no-auth)",
                    exc.message,
                    ENV_TOKEN,
                )
                self._set_fatal_error(
                    ERROR_UNAUTHORIZED, "Slick: " + exc.message, retryable=False
                )
                return False
            logger.warning(
                "Slick: daemon not reachable yet (%s) — the stream reader will keep retrying",
                exc.message,
            )

        self._subscribe_to_turn_model()
        # The observer hooks were registered at plugin load, before this
        # workspace existed; this is where they learn which one to talk to.
        _STREAM_BRIDGE.attach(self)

        listed = await self._refresh_channel_kinds()
        if not self._verify_listen_scope(listed):
            return False

        if self._stream_task is None or self._stream_task.done():
            self._stream_task = asyncio.ensure_future(self._stream_loop())
        self._mark_connected()
        return True

    def _hook_handlers(self) -> Optional[Dict[str, Any]]:
        """The gateway's ``event -> handlers`` map, when there is one to reach.

        ``HookRegistry`` exposes no registration call — it discovers handlers
        from ``~/.hermes/hooks/`` — so subscribing means appending to its
        handler map.  Every access is defensive: the model stamp is a nicety
        and must never be able to break a connect or a delivery.
        """
        registry = getattr(getattr(self, "gateway_runner", None), "hooks", None)
        handlers = getattr(registry, "_handlers", None)
        return handlers if isinstance(handlers, dict) else None

    def _subscribe_to_turn_model(self) -> None:
        """Listen for the model the gateway just ran, so ``send`` can stamp it."""
        if self._turn_model_hooked:
            return
        handlers = self._hook_handlers()
        if handlers is None:
            logger.debug(
                "Slick: no gateway hook registry — replies will carry no model badge"
            )
            return
        handlers.setdefault(TURN_MODEL_EVENT, []).append(self._on_turn_end)
        self._turn_model_hooked = True

    def _unsubscribe_from_turn_model(self) -> None:
        """Drop the subscription so reconnects do not stack handlers."""
        handlers = self._hook_handlers()
        if handlers is not None:
            try:
                handlers.get(TURN_MODEL_EVENT, []).remove(self._on_turn_end)
            except ValueError:
                pass
        self._turn_model_hooked = False

    def _on_turn_end(self, event_type: str, context: Any) -> None:
        """Record what answered, for the chat whose reply is about to be posted.

        Fired for every platform the gateway serves, so it filters on ours —
        another platform's model must never end up on a Slick message.
        """
        if not isinstance(context, dict):
            return
        if str(context.get("platform") or "").strip() != PLATFORM_NAME:
            return
        chat_id = str(context.get("chat_id") or "")
        thread_id = str(context.get("thread_id") or "")
        if not thread_id:
            # agent:start builds the context from source.thread_id, which every
            # Slick turn has; a turn that reached the gateway some other way
            # still has its target on the stack.
            thread_id = str((_TURN_TARGET.get() or {}).get("thread_id") or "")
        key = memo_key(chat_id, thread_id)
        self._turn_models.put(key, normalise_model(context.get("model")))
        # The hook says which model ran but not how hard it was told to think,
        # so that comes from the session Hermes just wrote.
        self._turn_efforts.put(key, session_effort(context.get("session_id")))

    def _memo_keys(
        self,
        chat_id: Any,
        target: Any,
        thread_id: Any,
        metadata: Optional[Dict[str, Any]],
    ) -> List[str]:
        """Where this send's badge could have been written down, best first.

        The turn on the stack is the exact answer and the one ``agent:end``
        wrote under; the thread being replied into is usually the same id by
        another route; the thread-less pair is what a turn whose thread nobody
        ever learned falls back to.
        """
        threads = [t for t in (self._typing_thread(chat_id, metadata), thread_id) if t]
        threads.append("")
        keys: List[str] = []
        for chat in (chat_id, target):
            for thread in threads:
                key = memo_key(chat, thread)
                if key and key not in keys:
                    keys.append(key)
        return keys

    def _stamp_run(
        self,
        chat_id: Any,
        target: Any,
        thread_id: Any,
        metadata: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        """Add ``_model`` and ``_effort`` so Slick can badge the message.

        Only ever adds.  Values Hermes already put in the metadata are the more
        specific answer and are left alone, and a turn we never saw the end of
        leaves the metadata untouched rather than guessing from config — an
        approximate badge under "Answered by" would be a lie.
        """
        keys = self._memo_keys(chat_id, target, thread_id, metadata)
        model = self._turn_models.get(*keys)
        effort = self._turn_efforts.get(*keys)
        if not model and not effort:
            return metadata
        stamped = dict(metadata or {})
        if model:
            stamped.setdefault(MODEL_METADATA_KEY, model)
        if effort:
            stamped.setdefault(EFFORT_METADATA_KEY, effort)
        return stamped

    def _verify_listen_scope(self, listed: bool) -> bool:
        """Refuse to come up listening to a channel the workspace lacks.

        ``connect`` only pings ``/api/health``, so a renamed, deleted or
        typo'd channel used to look perfectly healthy: the platform reported
        "connected" while the reader 404'd on every reconnect forever and no
        message ever reached the agent.

        Only a channel list we actually read can disprove a name, hence
        ``listed`` — a daemon that was unreachable a moment ago leaves the
        scope unverified and the reader retries exactly as before.
        """
        if not listed or not self.channel_filter:
            return True
        missing = sorted(name for name in self.channel_filter if name not in self._channel_kinds)
        if not missing:
            return True
        if self.scope:
            message = 'Slick: no channel named "{}" in this workspace'.format(self.scope)
            logger.error("%s — run `slick channel list` and fix the configured channel", message)
            self._set_fatal_error(ERROR_CHANNEL_NOT_FOUND, message, retryable=False)
            return False
        # A comma list still has somewhere to listen; name what will not arrive
        # rather than failing the whole platform over one stale entry.
        logger.warning(
            "Slick: no channel named %s in this workspace — the rest of the list still streams",
            ", ".join('"{}"'.format(name) for name in missing),
        )
        return True

    async def disconnect(self) -> None:
        """Stop the reader.  Bounded: never blocks the gateway shutdown path."""
        self._closing = True
        self._mark_disconnected()
        self._unsubscribe_from_turn_model()
        _STREAM_BRIDGE.detach(self)
        self._close_response()

        task, self._stream_task = self._stream_task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await asyncio.wait_for(task, timeout=DISCONNECT_TIMEOUT)
            except asyncio.TimeoutError:
                logger.warning("Slick: stream reader did not stop within %ss", DISCONNECT_TIMEOUT)
            except asyncio.CancelledError:
                pass
            except Exception:  # pragma: no cover - defensive
                logger.debug("Slick: stream reader raised on shutdown", exc_info=True)
        logger.info("Slick: disconnected")

    def _close_response(self) -> None:
        """Close the live SSE response — this is what unblocks the reader."""
        response, self._stream_response = self._stream_response, None
        if response is None:
            return
        try:
            response.close()
        except Exception:  # pragma: no cover - defensive
            logger.debug("Slick: closing the stream response failed", exc_info=True)

    # -- inbound -----------------------------------------------------------

    async def _stream_loop(self) -> None:
        """Read ``/api/stream`` forever, reconnecting with Last-Event-ID."""
        url = stream_url(self.base_url, self.scope)
        delay = self.retry_seconds
        while not self._closing:
            parser = SSEParser()
            try:
                response = await asyncio.to_thread(
                    open_stream_sync, url, self._token, self._last_event_id, self.stream_timeout
                )
            except SlickApiError as exc:
                if exc.status in (401, 403):
                    logger.error("Slick: stream refused (%s) — stopping reader", exc.message)
                    self._set_fatal_error(
                        ERROR_UNAUTHORIZED, "Slick: " + exc.message, retryable=False
                    )
                    return
                if exc.status == 404:
                    # The channel went away mid-run (renamed or deleted).
                    # Reconnecting cannot conjure it back, so retrying every
                    # 30s only hides a dead inbound path behind a healthy
                    # looking platform — the same trap _verify_listen_scope
                    # closes at startup.
                    logger.error("Slick: stream target is gone (%s) — stopping reader", exc.message)
                    self._set_fatal_error(
                        ERROR_CHANNEL_NOT_FOUND, "Slick: " + exc.message, retryable=False
                    )
                    return
                logger.warning("Slick: stream connect failed (%s)", exc.message)
                if not await self._sleep_before_retry(delay):
                    return
                delay = min(MAX_RETRY_SECONDS, max(self.retry_seconds, delay * 2))
                continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("Slick: stream connect error (%s)", _redact(exc, self._token))
                if not await self._sleep_before_retry(delay):
                    return
                continue

            delay = self.retry_seconds
            self._stream_response = response
            logger.debug("Slick: streaming %s (since %s)", url, self._last_event_id)
            try:
                while not self._closing:
                    line = await asyncio.to_thread(self._read_line, response)
                    if line is None:
                        break
                    event = parser.feed_line(line)
                    if event is None:
                        continue
                    if event.get("id"):
                        self._last_event_id = str(event["id"])
                    await self._handle_stream_event(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("Slick: stream read error (%s)", _redact(exc, self._token))
            finally:
                self._close_response()
                try:
                    response.close()
                except Exception:
                    pass

            if self._closing:
                return
            if not await self._sleep_before_retry(delay):
                return

    async def _sleep_before_retry(self, delay: float) -> bool:
        """Sleep between reconnects.  False means "we are shutting down"."""
        if self._closing:
            return False
        try:
            await asyncio.sleep(max(0.0, delay))
        except asyncio.CancelledError:
            raise
        return not self._closing

    @staticmethod
    def _read_line(response: Any) -> Optional[str]:
        """One SSE line, or None on EOF / a closed socket."""
        try:
            raw = response.readline()
        except Exception:
            return None
        if not raw:
            return None
        if isinstance(raw, bytes):
            return raw.decode("utf-8", "replace")
        return str(raw)

    async def _handle_stream_event(self, event: Dict[str, Any]) -> None:
        """Filter one SSE frame and hand anything real to the gateway."""
        data = event.get("json")
        if not isinstance(data, dict):
            return
        if data.get("type") != "message.created":
            return

        message = data.get("message")
        if not isinstance(message, dict):
            # An unhydrated event (deleted row, or a payload we cannot read)
            # carries no text to answer.
            return
        message_id = str(message.get("id") or "")
        if not message_id or message.get("deleted"):
            return

        author = message.get("author") if isinstance(message.get("author"), dict) else {}
        if str((author or {}).get("kind") or "").lower() == "agent":
            return
        if message_id in self._own_message_ids:
            return
        if not str(message.get("text") or "").strip():
            return

        channel_slug = message.get("channelSlug") or None
        channel_id = message.get("channelId") or data.get("channelId") or None
        if self.channel_filter is not None:
            names = {str(name).lower() for name in (channel_slug, channel_id) if name}
            if not (names & self.channel_filter):
                return

        if self.allowed_users:
            identities = {
                str(value).lower()
                for value in ((author or {}).get("id"), (author or {}).get("label"))
                if value
            }
            if not (identities & self.allowed_users):
                logger.debug("Slick: ignoring message from unauthorised author")
                return

        seq = data.get("seq")
        if seq is None:
            seq = event.get("id")
        if seq is not None and not self._seen_event_seqs.add(str(seq)):
            return
        if not self._seen_message_ids.add(message_id):
            return

        event = self._build_message_event(data, message)
        # Set around the dispatch, not inside it: whatever task the gateway
        # runs the turn in copies this context at creation, and the reset
        # keeps the stream reader's own context clean between messages.
        token = _TURN_TARGET.set(
            {
                "chat_id": str(getattr(event.source, "chat_id", "") or ""),
                "thread_id": str((event.metadata or {}).get("slick_thread_id") or message_id),
            }
        )
        # The same target, published where a thread that has no copy of this
        # context can still find it: the stream observer's dispatcher thread
        # was started long before this turn.
        _STREAM_BRIDGE.turn_started(_TURN_TARGET.get() or {})
        # Whether there is an answer at the end of this decides what the box
        # says.  A turn that raised, or one cancelled out from under us, left
        # its steps wherever they were — and a cancelled turn is still a turn
        # nobody got an answer to.
        failed = False
        try:
            await self.handle_message(event)
        except asyncio.CancelledError:
            failed = True
            raise
        except Exception:
            failed = True
            logger.error("Slick: failed to dispatch message %s", message_id, exc_info=True)
        finally:
            _STREAM_BRIDGE.turn_finished(_TURN_TARGET.get() or {}, failed=failed)
            _TURN_TARGET.reset(token)

    def _build_message_event(self, data: Dict[str, Any], message: Dict[str, Any]) -> MessageEvent:
        """Turn a hydrated ``message.created`` event into a ``MessageEvent``."""
        author = message.get("author") if isinstance(message.get("author"), dict) else {}
        author = author or {}
        message_id = str(message.get("id") or "")
        channel_slug = message.get("channelSlug") or None
        channel_id = message.get("channelId") or data.get("channelId") or None
        chat_id = str(channel_slug or channel_id or "")

        # Slick's threadId is the root's id, and a root message's own id — so
        # every message belongs to exactly one thread and nothing is outside
        # one. Hermes already folds thread_id into the session key, so passing
        # it for the root as well is the whole of "one session per thread":
        # without it a channel post and the thread it opens are two different
        # conversations, which is exactly the seam you feel when the agent
        # forgets what it just said.
        raw_thread = message.get("threadId")
        thread_id = str(raw_thread) if raw_thread else None

        user_id = str(author.get("id") or "") or None
        user_name = str(author.get("label") or "") or user_id

        source = self.build_source(
            chat_id=chat_id,
            chat_name="#{}".format(channel_slug) if channel_slug else chat_id,
            chat_type=self._chat_type_for(channel_slug, channel_id),
            user_id=user_id,
            user_name=user_name,
            thread_id=thread_id,
            message_id=message_id,
        )

        metadata = {
            "slick_message_id": message_id,
            "slick_channel_id": str(channel_id) if channel_id else None,
            "slick_channel_slug": str(channel_slug) if channel_slug else None,
            "slick_channel": chat_id,
            "slick_thread_id": str(raw_thread) if raw_thread else message_id,
            "slick_parent_id": str(message.get("parentId")) if message.get("parentId") else None,
            "slick_is_thread_root": bool(message.get("isThreadRoot", not message.get("parentId"))),
            "slick_seq": data.get("seq"),
            "slick_message_seq": message.get("seq"),
            "slick_author_id": user_id,
            "slick_author_kind": str(author.get("kind") or "") or None,
            "slick_url": self.base_url,
        }

        return MessageEvent(
            text=str(message.get("text") or ""),
            message_type=MessageType.TEXT,
            user_id=user_id,
            user_name=user_name,
            source=source,
            raw_message=message,
            message_id=message_id,
            metadata=metadata,
            timestamp=_timestamp(message.get("createdAt")),
        )

    def _chat_type_for(self, channel_slug: Any, channel_id: Any) -> str:
        """"dm" for a direct-message channel, "channel" for everything else."""
        for key in (channel_slug, channel_id):
            if not key:
                continue
            kind = self._channel_kinds.get(str(key).lower())
            if kind:
                return "dm" if kind == "dm" else "channel"
        return "channel"

    async def _refresh_channel_kinds(self) -> bool:
        """Cache each channel's kind so inbound events can be typed.

        Typing is best effort: the stream carries a channel's slug and id but
        not its kind, and a missing cache just means everything reads as a
        channel.  The return value is not — True means the workspace's channel
        list was genuinely read, which is what lets
        :meth:`_verify_listen_scope` tell "no such channel" apart from "could
        not ask".
        """
        try:
            _, data = await asyncio.to_thread(
                api_request,
                "GET",
                "{}/api/channels?includeArchived=1".format(self.base_url),
                self._token,
                None,
                self.request_timeout,
            )
        except SlickApiError as exc:
            logger.debug("Slick: channel list unavailable (%s)", exc.message)
            return False
        except Exception:  # pragma: no cover - defensive
            logger.debug("Slick: channel list failed", exc_info=True)
            return False
        channels = (data or {}).get("channels")
        if not isinstance(channels, list):
            return False
        for channel in channels:
            if not isinstance(channel, dict):
                continue
            kind = str(channel.get("kind") or "channel").lower()
            for key in (channel.get("slug"), channel.get("id")):
                if key:
                    self._channel_kinds[str(key).lower()] = kind
        return True

    # -- outbound ----------------------------------------------------------

    def _author(self) -> Dict[str, Any]:
        """Hermes always writes as an agent — see the module docstring."""
        return {"id": self.agent_id, "kind": "agent", "label": self.agent_label}

    # -- typing ------------------------------------------------------------

    def _typing_thread(self, chat_id: Any, metadata: Optional[Dict[str, Any]]) -> Optional[str]:
        """Which thread an indicator belongs to, or None to draw nothing.

        A caller that names a thread wins — that is how a platform with its
        own routing (Slack's per-thread status) is meant to speak.  Otherwise
        the turn on the stack says, which is the ordinary case: the gateway
        calls ``send_typing`` with a chat and nothing else.

        The chats have to agree.  A turn's thread belongs to that turn's
        channel, so borrowing it for some other chat would light up a thread
        nobody is answering.
        """
        for key in ("slick_thread_id", "thread_id"):
            value = (metadata or {}).get(key)
            if value:
                return str(value)
        turn = _TURN_TARGET.get()
        if not turn:
            return None
        chat = str(chat_id or "")
        if chat and turn.get("chat_id") and chat != turn["chat_id"]:
            return None
        return turn.get("thread_id") or None

    async def _signal_typing(
        self, chat_id: Any, on: bool, metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        """Tell Slick the agent is (or is no longer) working on that thread.

        Best effort throughout.  An indicator is a nicety, and a workspace too
        old to know the route — or simply busy — must not cost anyone their
        answer, so nothing here is allowed to reach the gateway.
        """
        thread_id = self._typing_thread(chat_id, metadata)
        if not thread_id:
            return
        try:
            await asyncio.to_thread(
                api_request,
                "POST",
                "{}/api/typing".format(self.base_url),
                self._token,
                {"agentId": self.agent_id, "threadId": thread_id, "on": bool(on)},
                self.request_timeout,
            )
        except SlickApiError as exc:
            logger.debug(
                "Slick: typing %s for %s failed (%s)", "on" if on else "off", thread_id, exc.message
            )
        except Exception:  # pragma: no cover - defensive
            logger.debug("Slick: typing signal failed", exc_info=True)

    async def send_typing(self, chat_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Light the indicator in the thread this turn is answering."""
        await self._signal_typing(chat_id, True, metadata)

    async def stop_typing(self, chat_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Put it out again.

        The base class introspects this signature before passing ``metadata``
        (``_stop_typing_with_metadata``), so keeping the parameter is what
        lets a stop reach the same thread the start did.
        """
        await self._signal_typing(chat_id, False, metadata)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Post ``content`` into a channel, or into a thread when we have one."""
        thread_id = thread_target(reply_to, metadata)
        target = str(chat_id or "").strip() or self.home_channel
        if not thread_id and not target:
            return SendResult(
                success=False,
                error="Slick: no channel to send to (set {})".format(ENV_CHANNEL),
                error_kind="not_found",
            )
        metadata = self._stamp_run(chat_id, target, thread_id, metadata)

        try:
            data = await asyncio.to_thread(
                post_message_sync,
                self.base_url,
                self._token,
                target,
                content,
                thread_id,
                metadata,
                self._author(),
                self.request_timeout,
            )
        except SlickApiError as exc:
            logger.warning("Slick: send failed (%s)", exc.message)
            return SendResult(
                success=False,
                error=exc.message,
                retryable=exc.retryable,
                error_kind=_error_kind(exc),
                raw_response=exc.payload,
            )

        message = data.get("message") if isinstance(data, dict) else None
        message_id = None
        if isinstance(message, dict) and message.get("id"):
            message_id = str(message["id"])
            self._own_message_ids.add(message_id)
        return SendResult(success=True, message_id=message_id, raw_response=data)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        """Look up a channel.  Always returns a dict — never raises at callers."""
        ref = str(chat_id or "").strip() or self.home_channel or self.channel
        info: Dict[str, Any] = {
            "id": ref,
            "name": ref,
            "type": self._chat_type_for(ref, None),
            "platform": PLATFORM_NAME,
            "url": self.base_url,
        }
        if not ref:
            info["error"] = "no channel configured"
            return info
        try:
            _, data = await asyncio.to_thread(
                api_request,
                "GET",
                "{}/api/channels/{}".format(self.base_url, urllib.parse.quote(str(ref), safe="")),
                self._token,
                None,
                self.request_timeout,
            )
        except SlickApiError as exc:
            info["error"] = exc.message
            return info
        except Exception:  # pragma: no cover - defensive
            logger.debug("Slick: channel lookup failed", exc_info=True)
            info["error"] = "channel lookup failed"
            return info

        channel = (data or {}).get("channel")
        if not isinstance(channel, dict):
            return info
        kind = str(channel.get("kind") or "channel").lower()
        for key in (channel.get("slug"), channel.get("id")):
            if key:
                self._channel_kinds[str(key).lower()] = kind
        info.update(
            {
                "id": channel.get("id") or ref,
                "name": channel.get("name") or channel.get("slug") or ref,
                "slug": channel.get("slug"),
                "type": "dm" if kind == "dm" else "channel",
                "kind": kind,
                "topic": channel.get("topic"),
                "archived": bool(channel.get("archived")),
            }
        )
        return info


def thread_target(reply_to: Optional[str], metadata: Optional[Dict[str, Any]]) -> Optional[str]:
    """The thread root to reply into, if this send belongs in a thread.

    ``reply_to`` is a Slick message id — replying to a reply joins its thread
    server-side, so passing the message id straight through is correct.
    """
    if reply_to:
        return str(reply_to)
    if isinstance(metadata, dict):
        for key in ("slick_thread_id", "slick_root_id", "thread_id", "threadId", "root_id"):
            value = metadata.get(key)
            if value:
                return str(value)
    return None


def _error_kind(exc: SlickApiError) -> str:
    status = exc.status
    if status in (401, 403):
        return "forbidden"
    if status == 404:
        return "not_found"
    if status == 429:
        return "rate_limited"
    if status == 422 or status == 409:
        return "bad_format"
    if status is None or status >= 500:
        return "transient"
    return "unknown"


# --------------------------------------------------------------------------
# Plugin registration
# --------------------------------------------------------------------------

def check_requirements() -> bool:
    """Passive dependency probe.  Stdlib only, so nothing can be missing.

    ``check_fn`` takes no config argument, so it cannot see credentials that
    live in ``PlatformConfig.extra``.  Gating it on the environment would hard-
    block a valid ``config.yaml``-only setup: both ``load_gateway_config()``
    and ``platform_registry.create_adapter()`` treat a False ``check_fn`` with
    no ``ensure_deps_fn`` as fatal.  The credential gate is
    :func:`validate_config` / :func:`is_connected`, which do get the config.
    """
    return True


def validate_config(config: Any) -> bool:
    """Enough to be worth connecting?

    Nothing is mandatory any more — url, token and listen scope all have
    defaults — so what is left to check is whether a daemon is identifiable at
    all: either the operator named one, or one published itself in
    ``daemon.json``.  A host with no Slick installed and no config keeps the
    platform out of ``gateway status`` rather than advertising a daemon that
    was never there.
    """
    extra = _extra(config)
    named = bool(
        _env(ENV_URL)
        or _get_secret(ENV_TOKEN)
        or _env(ENV_CHANNEL)
        or any(str(extra.get(key) or "").strip() for key in ("url", "token", "channel"))
    )
    return named or bool(read_daemon_file())


def is_connected(config: Any) -> bool:
    """Whether the gateway should treat Slick as an available platform."""
    return validate_config(config)


def _env_enablement() -> Optional[Dict[str, Any]]:
    """Seed ``PlatformConfig.extra`` from env before the adapter is built.

    Runs during gateway config load so ``gateway status`` reflects env-only
    setups.  The token is deliberately NOT seeded: it stays in the env (or the
    secret scope) instead of being copied into a config object that gets
    serialised into status output.
    """
    # Any SLICK_* var is an explicit opt-in.  A running daemon is not: keying
    # off daemon.json here would hand a gateway platform to every host that
    # merely has Slick installed.
    if not any(
        _env(name)
        for name in (ENV_URL, ENV_TOKEN, ENV_CHANNEL, ENV_HOME_CHANNEL, ENV_ALLOWED_USERS)
    ):
        return None
    channel = resolve_channel()
    seed: Dict[str, Any] = {"url": resolve_url(), "channel": channel}
    allowed = _env(ENV_ALLOWED_USERS)
    if allowed:
        seed["allowed_users"] = sorted(parse_allowed_users(allowed))
    agent_id = _env(ENV_AGENT_ID)
    if agent_id:
        seed["agent_id"] = agent_id
    agent_label = _env(ENV_AGENT_LABEL)
    if agent_label:
        seed["agent_label"] = agent_label
    home = resolve_home_channel({"channel": channel})
    if home:
        # The core hook turns this into a HomeChannel dataclass rather than
        # merging it into extra.
        seed["home_channel"] = {"chat_id": home, "name": home}
    return seed


async def _standalone_send(
    pconfig: Any,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[List[str]] = None,
    force_document: bool = False,
) -> Dict[str, Any]:
    """Deliver a message with no live adapter (out-of-process cron).

    Same REST call as :meth:`SlickAdapter.send`, opened fresh: ``hermes cron``
    often runs in a different process from ``hermes gateway``, where the
    in-process adapter weakref is None and ``deliver=slick`` would otherwise
    fail with "No live adapter for platform".
    """
    extra = _extra(pconfig)
    token_from_config = getattr(pconfig, "token", None)
    if token_from_config and not extra.get("token"):
        extra["token"] = token_from_config

    token = resolve_token(extra)
    if not token:
        return {"error": "Slick standalone send: {} is not set".format(ENV_TOKEN)}

    target = str(chat_id or "").strip() or resolve_home_channel(extra)
    if not thread_id and not target:
        return {"error": "Slick standalone send: no channel (set {})".format(ENV_CHANNEL)}
    if media_files:
        # Slick messages are text + metadata; there is no attachment endpoint.
        logger.warning("Slick standalone send: %d media file(s) skipped", len(media_files))

    base_url = resolve_url(extra)
    author = {
        "id": _env(ENV_AGENT_ID) or str(extra.get("agent_id") or "") or DEFAULT_AGENT_ID,
        "kind": "agent",
        "label": _env(ENV_AGENT_LABEL) or str(extra.get("agent_label") or "") or DEFAULT_AGENT_LABEL,
    }
    timeout = _number_setting(extra, "request_timeout", ENV_REQUEST_TIMEOUT, DEFAULT_REQUEST_TIMEOUT)
    try:
        data = await asyncio.to_thread(
            post_message_sync,
            base_url,
            token,
            target,
            message,
            thread_id,
            {"via": "hermes-cron"},
            author,
            timeout,
        )
    except SlickApiError as exc:
        return {"error": exc.message}
    except Exception as exc:  # pragma: no cover - defensive
        return {"error": _redact("Slick standalone send failed: {}".format(exc), token)}

    posted = data.get("message") if isinstance(data, dict) else None
    message_id = str(posted["id"]) if isinstance(posted, dict) and posted.get("id") else None
    return {"success": True, "message_id": message_id}


def register(ctx: Any) -> None:
    """Plugin entry point: called by the Hermes plugin system."""
    ctx.register_platform(
        name=PLATFORM_NAME,
        label=PLATFORM_LABEL,
        adapter_factory=lambda cfg: SlickAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        # Nothing is required: the url and token come from daemon.json and the
        # listen scope defaults to every channel.
        required_env=[],
        install_hint="No extra packages needed (stdlib only). Start the daemon with `slick daemon start`.",
        # Env-driven auto-configuration: seeds url/channel/home_channel so an
        # env-only setup shows up in gateway status without constructing the
        # adapter.
        env_enablement_fn=_env_enablement,
        # cron `deliver=slick` resolves its default target from this var,
        # which falls back to SLICK_CHANNEL in _env_enablement.
        cron_deliver_env_var=ENV_HOME_CHANNEL,
        # Out-of-process cron delivery (cron running beside, not inside, the
        # gateway process).
        standalone_sender_fn=_standalone_send,
        allowed_users_env=ENV_ALLOWED_USERS,
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="🧵",
        platform_hint=PLATFORM_HINT,
    )

    # Live progress, if this host has the observer hooks at all.  They are
    # process-wide and fire for every surface Hermes serves, so each callback
    # begins by checking whose turn it is looking at — see _StreamBridge.
    #
    # Note what is NOT registered: no edit_message, no
    # SUPPORTS_MESSAGE_EDITING, no streaming.enabled.  Gateway streaming grows
    # a real message by editing it, and gateway/platforms/base.py answers
    # edit_message with SendResult(success=False, error="Not supported") for an
    # adapter that has not written one — GatewayStreamConsumer then disables
    # edits for the rest of the run.  Switching it on without implementing the
    # edit would leave a half-finished message behind and append the whole
    # answer again underneath it, every single turn.  A Slick draft is an SSE
    # frame instead: there is no row to strand and nothing to edit.
    register_hook = getattr(ctx, "register_hook", None)
    if not callable(register_hook):
        logger.debug("Slick: this host has no register_hook — no live progress")
        return
    for name, callback in _STREAM_BRIDGE.hooks():
        register_hook(name, callback)
