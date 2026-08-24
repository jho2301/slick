"""Unit tests for the Slick Hermes platform plugin.

Run them from the repository root::

    python3 -m unittest discover -s plugins/hermes/slick -p "test_*.py"

Nothing here touches a real Slick daemon.  Outbound and stream tests run
against a ``http.server`` bound to a free loopback port; everything else is a
pure-function or in-memory check.

``adapter.py`` imports ``gateway.platforms.base`` and ``gateway.config`` from
the Hermes runtime, which is not on the path here — so this module installs
stand-ins for those two modules before importing it.  The stubs are installed
unconditionally, so the suite behaves the same whether or not a Hermes
checkout happens to be importable, and ``TestHermesContract`` reads the real
Hermes source (when present) to prove the stubs have not drifted from it.
"""

import ast
import asyncio
import contextlib
import enum
import importlib.util
import json
import os
import shutil
import socket
import sqlite3
import sys
import tempfile
import time
import unittest.mock
import threading
import types
import unittest
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Hermes stand-ins
# ---------------------------------------------------------------------------

HERMES_ROOT = Path(
    os.environ.get("HERMES_AGENT_ROOT") or (Path.home() / ".hermes" / "hermes-agent")
)


class Platform(enum.Enum):
    """Mirrors ``gateway.config.Platform`` for the one value we construct."""

    SLICK = "slick"

    @classmethod
    def _missing_(cls, value):
        return None


class MessageType(enum.Enum):
    TEXT = "text"
    LOCATION = "location"
    PHOTO = "photo"
    DOCUMENT = "document"
    COMMAND = "command"


@dataclass
class SessionSource:
    platform: Any = None
    chat_id: str = ""
    chat_name: Optional[str] = None
    chat_type: str = "dm"
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    thread_id: Optional[str] = None
    chat_topic: Optional[str] = None
    user_id_alt: Optional[str] = None
    chat_id_alt: Optional[str] = None
    is_bot: bool = False
    scope_id: Optional[str] = None
    guild_id: Optional[str] = None
    parent_chat_id: Optional[str] = None
    message_id: Optional[str] = None
    profile: Optional[str] = None
    role_authorized: bool = False
    auto_thread_created: bool = False
    auto_thread_initial_name: Optional[str] = None


@dataclass
class MessageEvent:
    text: str
    message_type: Any = MessageType.TEXT
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    source: Any = None
    raw_message: Any = None
    message_id: Optional[str] = None
    media_urls: List[str] = field(default_factory=list)
    media_types: List[str] = field(default_factory=list)
    reply_to_message_id: Optional[str] = None
    internal: bool = False
    metadata: Dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.now)


@dataclass
class SendResult:
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    raw_response: Any = None
    retryable: bool = False
    retry_after: Optional[float] = None
    continuation_message_ids: tuple = ()
    error_kind: Optional[str] = None


@dataclass
class PlatformConfig:
    enabled: bool = False
    token: Optional[str] = None
    api_key: Optional[str] = None
    home_channel: Any = None
    reply_to_mode: str = "first"
    extra: Dict[str, Any] = field(default_factory=dict)


class BasePlatformAdapter:
    """The slice of ``gateway.platforms.base.BasePlatformAdapter`` we rely on."""

    supports_code_blocks = False
    supports_async_delivery = True
    splits_long_messages = False
    gateway_runner = None

    def __init__(self, config, platform):
        self.config = config
        self.platform = platform
        self._message_handler = None
        self._running = False
        self._fatal_error_code = None
        self._fatal_error_message = None
        self._fatal_error_retryable = True

    @property
    def is_connected(self) -> bool:
        return self._running

    @property
    def has_fatal_error(self) -> bool:
        return self._fatal_error_message is not None

    def _mark_connected(self) -> None:
        self._running = True
        self._fatal_error_code = None
        self._fatal_error_message = None
        self._fatal_error_retryable = True

    def _mark_disconnected(self) -> None:
        self._running = False

    def _set_fatal_error(self, code, message, *, retryable) -> None:
        self._running = False
        self._fatal_error_code = code
        self._fatal_error_message = message
        self._fatal_error_retryable = retryable

    def set_message_handler(self, handler) -> None:
        self._message_handler = handler

    def build_source(
        self,
        chat_id,
        chat_name=None,
        chat_type="dm",
        user_id=None,
        user_name=None,
        thread_id=None,
        chat_topic=None,
        user_id_alt=None,
        chat_id_alt=None,
        is_bot=False,
        scope_id=None,
        guild_id=None,
        parent_chat_id=None,
        message_id=None,
        role_authorized=False,
        auto_thread_created=False,
        auto_thread_initial_name=None,
    ) -> SessionSource:
        return SessionSource(
            platform=self.platform,
            chat_id=str(chat_id),
            chat_name=chat_name,
            chat_type=chat_type,
            user_id=str(user_id) if user_id else None,
            user_name=user_name,
            thread_id=str(thread_id) if thread_id else None,
            chat_topic=chat_topic,
            message_id=str(message_id) if message_id else None,
        )

    async def handle_message(self, event) -> None:
        return None


def _install_hermes_stubs() -> None:
    gateway = types.ModuleType("gateway")
    gateway.__path__ = []  # type: ignore[attr-defined]
    platforms = types.ModuleType("gateway.platforms")
    platforms.__path__ = []  # type: ignore[attr-defined]
    base = types.ModuleType("gateway.platforms.base")
    config_module = types.ModuleType("gateway.config")

    base.BasePlatformAdapter = BasePlatformAdapter
    base.MessageEvent = MessageEvent
    base.MessageType = MessageType
    base.SendResult = SendResult
    base.SessionSource = SessionSource
    config_module.Platform = Platform
    config_module.PlatformConfig = PlatformConfig

    gateway.platforms = platforms
    gateway.config = config_module
    platforms.base = base

    sys.modules["gateway"] = gateway
    sys.modules["gateway.platforms"] = platforms
    sys.modules["gateway.platforms.base"] = base
    sys.modules["gateway.config"] = config_module


_install_hermes_stubs()

sys.path.insert(0, str(Path(__file__).resolve().parent))

import adapter  # noqa: E402  (must follow the stub install)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SLICK_ENV_VARS = (
    "SLICK_HOME",
    "SLICK_URL",
    "SLICK_TOKEN",
    "SLICK_CHANNEL",
    "SLICK_HOME_CHANNEL",
    "SLICK_ALLOWED_USERS",
    "SLICK_AGENT_ID",
    "SLICK_AGENT_LABEL",
    "SLICK_REQUEST_TIMEOUT",
    "SLICK_STREAM_TIMEOUT",
    "SLICK_RETRY_SECONDS",
)

TOKEN = "slick-test-token-abcdef"


class EnvSandbox(unittest.TestCase):
    """Every test starts with no SLICK_* env, and leaves the process as found.

    ``SLICK_HOME`` is not merely cleared but pointed at an empty temp dir: the
    adapter reads ``$SLICK_HOME/daemon.json`` for the url and token, and a
    developer running the suite on a machine with a live workspace would
    otherwise have the real daemon's values leak into every assertion.
    """

    def setUp(self) -> None:
        super().setUp()
        self._saved_env = {name: os.environ.get(name) for name in SLICK_ENV_VARS}
        for name in SLICK_ENV_VARS:
            os.environ.pop(name, None)
        self.slick_home = tempfile.mkdtemp(prefix="slick-home-")
        self.addCleanup(shutil.rmtree, self.slick_home, True)
        os.environ["SLICK_HOME"] = self.slick_home

    def write_daemon_file(self, **fields: Any) -> str:
        """Publish a ``daemon.json`` the way ``slickd`` does on startup."""
        target = os.path.join(self.slick_home, "daemon.json")
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(fields, handle)
        return target

    def tearDown(self) -> None:
        for name, value in self._saved_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        super().tearDown()

    def set_env(self, **values: str) -> None:
        for name, value in values.items():
            os.environ[name] = value


def make_config(url: str, channel: str = "general", token: str = TOKEN, **extra: Any) -> PlatformConfig:
    settings: Dict[str, Any] = {
        "url": url,
        "channel": channel,
        "token": token,
        "request_timeout": 5,
        "stream_timeout": 5,
        "retry_seconds": 0.05,
    }
    settings.update(extra)
    return PlatformConfig(enabled=True, extra=settings)


def make_adapter(url: str = "http://127.0.0.1:1", channel: str = "general", **extra: Any):
    return adapter.SlickAdapter(make_config(url, channel, **extra))


def message_event(
    seq: int = 11,
    message_id: str = "msg_1",
    text: str = "hello hermes",
    author_kind: str = "human",
    author_id: str = "fano",
    author_label: str = "Fano",
    channel_slug: Optional[str] = "general",
    channel_id: str = "ch_1",
    thread_id: Optional[str] = None,
    parent_id: Optional[str] = None,
    created_at: int = 1_700_000_000_000,
    deleted: bool = False,
) -> Dict[str, Any]:
    """A hydrated ``message.created`` event, shaped like the daemon's."""
    return {
        "seq": seq,
        "type": "message.created",
        "actor": {"id": author_id, "kind": author_kind},
        "channelId": channel_id,
        "channelSlug": channel_slug,
        "messageId": message_id,
        "threadId": thread_id or message_id,
        "payload": {"mentions": [], "isReply": bool(parent_id)},
        "createdAt": created_at,
        "message": {
            "id": message_id,
            "channelId": channel_id,
            "channelSlug": channel_slug,
            "parentId": parent_id,
            "threadId": thread_id or message_id,
            "isThreadRoot": parent_id is None,
            "author": {"id": author_id, "kind": author_kind, "label": author_label},
            "text": text,
            "mentions": [],
            "metadata": None,
            "seq": seq,
            "replyCount": 0,
            "createdAt": created_at,
            "updatedAt": created_at,
            "deleted": deleted,
        },
    }


def sse_block(event: Dict[str, Any]) -> bytes:
    return "id: {}\ndata: {}\n\n".format(event["seq"], json.dumps(event)).encode("utf-8")


def free_port() -> int:
    """A port that was free a moment ago — used to force a refused connection."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


CHANNELS = [
    {"id": "ch_1", "slug": "general", "name": "general", "kind": "channel", "topic": "everything"},
    {"id": "ch_dm", "slug": "fano-dm", "name": "fano-dm", "kind": "dm", "topic": None},
]


class FakeSlick:
    """A loopback stand-in for the Slick daemon's HTTP + SSE surface."""

    def __init__(self, sse_script: Optional[List[List[bytes]]] = None) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.sse_script = sse_script or []
        self.stream_connections = 0
        self.post_status = 201
        self.post_error: Optional[Dict[str, Any]] = None
        self.channels_status = 200
        self.health_status = 200
        self.stream_status = 200
        self.stream_error: Optional[Dict[str, Any]] = None
        self.lock = threading.Lock()

        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *args: Any) -> None:
                pass

            # -- recording --------------------------------------------------
            def record(self, body: Any = None) -> Dict[str, Any]:
                entry = {
                    "method": self.command,
                    "path": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": body,
                }
                with fake.lock:
                    fake.requests.append(entry)
                return entry

            def reply_json(self, status: int, payload: Any) -> None:
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            # -- routes -----------------------------------------------------
            def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
                self.record()
                path = urllib.parse.urlsplit(self.path).path
                if path == "/api/health":
                    if fake.health_status >= 400:
                        return self.reply_json(
                            fake.health_status,
                            {"error": {"code": "unauthorized", "message": "Missing or invalid token."}},
                        )
                    return self.reply_json(200, {"ok": True, "version": "test", "workspace": "Slick"})
                if path == "/api/channels":
                    if fake.channels_status >= 400:
                        return self.reply_json(
                            fake.channels_status,
                            {"error": {"code": "boom", "message": "the daemon fell over"}},
                        )
                    return self.reply_json(200, {"channels": CHANNELS})
                if path.startswith("/api/channels/"):
                    ref = urllib.parse.unquote(path.split("/api/channels/", 1)[1])
                    for channel in CHANNELS:
                        if ref in (channel["id"], channel["slug"]):
                            return self.reply_json(200, {"channel": channel})
                    return self.reply_json(
                        404, {"error": {"code": "not_found", "message": "No channel " + ref}}
                    )
                if path == "/api/stream":
                    return self.stream()
                return self.reply_json(404, {"error": {"code": "no_such_route", "message": path}})

            def stream(self) -> None:
                with fake.lock:
                    index = fake.stream_connections
                    fake.stream_connections += 1
                if fake.stream_status >= 400:
                    return self.reply_json(
                        fake.stream_status,
                        fake.stream_error
                        or {
                            "error": {
                                "code": "not_found",
                                "message": 'No channel named "general".',
                            }
                        },
                    )
                self.send_response(200)
                self.send_header("content-type", "text/event-stream; charset=utf-8")
                self.send_header("cache-control", "no-store")
                self.end_headers()
                frames = fake.sse_script[index] if index < len(fake.sse_script) else []
                self.wfile.write(b": keepalive\n\n")
                for frame in frames:
                    self.wfile.write(frame)
                self.wfile.flush()

            def do_POST(self) -> None:  # noqa: N802 (stdlib naming)
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length).decode("utf-8") if length else ""
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = raw
                self.record(body)
                if fake.post_status >= 400:
                    return self.reply_json(
                        fake.post_status,
                        fake.post_error
                        or {"error": {"code": "boom", "message": "the daemon fell over"}},
                    )
                path = urllib.parse.urlsplit(self.path).path
                if path == "/api/typing":
                    return self.reply_json(200, {"ok": True})
                parent = None
                if "/replies" in path:
                    parent = urllib.parse.unquote(path.split("/api/messages/", 1)[1].split("/")[0])
                return self.reply_json(
                    fake.post_status,
                    {
                        "message": {
                            "id": "msg_posted",
                            "channelId": "ch_1",
                            "channelSlug": "general",
                            "parentId": parent,
                            "threadId": parent or "msg_posted",
                            "author": {"id": "hermes", "kind": "agent", "label": "Hermes"},
                            "text": (body or {}).get("text") if isinstance(body, dict) else None,
                        }
                    },
                )

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return "http://{}:{}".format(host, port)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def find(self, method: str, needle: str) -> List[Dict[str, Any]]:
        with self.lock:
            return [r for r in self.requests if r["method"] == method and needle in r["path"]]


class FakeHookRegistry:
    """The slice of ``gateway.hooks.HookRegistry`` the adapter subscribes through."""

    def __init__(self) -> None:
        self._handlers: Dict[str, List[Any]] = {}

    async def emit(self, event_type: str, context: Dict[str, Any]) -> None:
        for fn in list(self._handlers.get(event_type, [])):
            result = fn(event_type, context)
            if asyncio.iscoroutine(result):
                await result


class FakeRunner:
    """What ``gateway/run.py`` assigns to ``adapter.gateway_runner``."""

    def __init__(self) -> None:
        self.hooks = FakeHookRegistry()


class FakeCtx:
    """Captures what ``register()`` hands to ``PluginContext``."""

    def __init__(self) -> None:
        self.platform_kwargs: Optional[Dict[str, Any]] = None
        self.hooks: List[Any] = []

    def register_platform(self, **kwargs: Any) -> None:
        self.platform_kwargs = kwargs

    def register_hook(self, hook_name: str, callback: Any) -> None:
        self.hooks.append((hook_name, callback))


# ---------------------------------------------------------------------------
# Registration & metadata
# ---------------------------------------------------------------------------

class TestRegistration(EnvSandbox):
    def setUp(self) -> None:
        super().setUp()
        self.ctx = FakeCtx()
        adapter.register(self.ctx)
        self.kwargs = self.ctx.platform_kwargs or {}

    def test_registers_the_slick_platform(self) -> None:
        self.assertEqual(self.kwargs.get("name"), "slick")
        self.assertEqual(self.kwargs.get("label"), "Slick")
        self.assertEqual(self.kwargs.get("emoji"), "🧵")
        self.assertEqual(self.kwargs.get("max_message_length"), 40_000)
        self.assertEqual(
            self.kwargs.get("required_env"),
            [],
            "url/token come from daemon.json and the channel defaults to '*'",
        )
        self.assertEqual(self.kwargs.get("cron_deliver_env_var"), "SLICK_HOME_CHANNEL")
        self.assertEqual(self.kwargs.get("allowed_users_env"), "SLICK_ALLOWED_USERS")
        self.assertIn("Slick", self.kwargs.get("platform_hint", ""))
        self.assertTrue(self.kwargs.get("install_hint"))

    def test_registers_every_required_hook(self) -> None:
        for name in (
            "adapter_factory",
            "check_fn",
            "validate_config",
            "is_connected",
            "env_enablement_fn",
            "standalone_sender_fn",
        ):
            self.assertTrue(callable(self.kwargs.get(name)), "{} must be callable".format(name))
        self.assertTrue(asyncio.iscoroutinefunction(self.kwargs["standalone_sender_fn"]))

    def test_registers_every_live_progress_hook(self) -> None:
        self.assertEqual(
            [name for name, _ in self.ctx.hooks], list(adapter.LIVE_PROGRESS_HOOKS)
        )
        for name, callback in self.ctx.hooks:
            self.assertTrue(callable(callback), "{} must be callable".format(name))

    def test_the_same_callbacks_are_handed_over_every_time(self) -> None:
        """``plugin_stream_hooks`` keys a dispatcher on ``id(callback)``.

        A bound method read off the instance is a new object each time, so
        registering twice with fresh ones would leave a dispatcher thread and
        its queue behind for the callbacks nobody will fire again.
        """
        again = FakeCtx()
        adapter.register(again)
        self.assertEqual(
            [callback for _, callback in again.hooks],
            [callback for _, callback in self.ctx.hooks],
        )

    def test_a_host_with_no_register_hook_still_gets_the_platform(self) -> None:
        """Live progress is additive; an older plugin API must still work."""

        class OlderHost:
            def __init__(self) -> None:
                self.platform_kwargs: Optional[Dict[str, Any]] = None

            def register_platform(self, **kwargs: Any) -> None:
                self.platform_kwargs = kwargs

        host = OlderHost()
        adapter.register(host)
        self.assertEqual((host.platform_kwargs or {}).get("name"), "slick")

    def test_the_editing_streaming_path_is_left_alone(self) -> None:
        """Turning gateway streaming on without an edit_message strands a
        partial message and appends the answer again beneath it, every turn."""
        self.assertNotIn("SUPPORTS_MESSAGE_EDITING", adapter.SlickAdapter.__dict__)
        self.assertNotIn("edit_message", adapter.SlickAdapter.__dict__)

    def test_adapter_factory_builds_an_adapter(self) -> None:
        built = self.kwargs["adapter_factory"](make_config("http://127.0.0.1:4477"))
        self.assertIsInstance(built, adapter.SlickAdapter)
        self.assertIs(built.platform, Platform.SLICK)
        self.assertFalse(built.is_connected)

    def test_check_fn_is_a_passive_dependency_probe(self) -> None:
        # It takes no config, so it must not gate on credentials: a False
        # check_fn with no ensure_deps_fn hard-blocks the platform, which
        # would kill a config.yaml-only setup.
        self.assertTrue(self.kwargs["check_fn"]())
        self.set_env(SLICK_TOKEN=TOKEN, SLICK_CHANNEL="general")
        self.assertTrue(self.kwargs["check_fn"]())

    def test_validate_config_needs_a_daemon_to_be_identifiable(self) -> None:
        empty = PlatformConfig(extra={})
        self.assertFalse(adapter.validate_config(empty), "no config and no daemon.json")
        self.assertFalse(adapter.is_connected(empty))
        self.assertTrue(adapter.validate_config(PlatformConfig(extra={"channel": "general"})))
        self.set_env(SLICK_CHANNEL="general")
        self.assertTrue(adapter.validate_config(empty))
        self.assertTrue(adapter.is_connected(empty))

    def test_a_published_daemon_is_config_enough(self) -> None:
        """A local workspace needs no config at all — daemon.json is the config."""
        empty = PlatformConfig(extra={})
        self.assertFalse(adapter.validate_config(empty))
        self.write_daemon_file(url="http://127.0.0.1:4477", token=None)
        self.assertTrue(adapter.validate_config(empty))
        self.assertTrue(adapter.is_connected(empty))

    def test_config_yaml_only_setup_passes_every_gate(self) -> None:
        # No SLICK_* env at all — credentials come from
        # gateway.platforms.slick.extra.  This is the exact combination the
        # gateway consults before enabling a plugin platform.
        yaml_only = PlatformConfig(extra={"token": TOKEN, "channel": "general"})
        self.assertTrue(self.kwargs["check_fn"]())
        self.assertTrue(self.kwargs["is_connected"](yaml_only))
        self.assertTrue(self.kwargs["validate_config"](yaml_only))


class TestEnvEnablement(EnvSandbox):
    def test_returns_none_until_configured(self) -> None:
        self.assertIsNone(adapter._env_enablement())
        self.write_daemon_file(url="http://127.0.0.1:4477", token=None)
        self.assertIsNone(
            adapter._env_enablement(),
            "a running daemon is not an opt-in to a gateway platform",
        )

    def test_any_slick_var_opts_in_and_the_channel_defaults_to_every(self) -> None:
        self.set_env(SLICK_TOKEN=TOKEN)
        seed = adapter._env_enablement() or {}
        self.assertEqual(seed.get("channel"), "*")
        self.assertNotIn("home_channel", seed, "a wildcard is not a delivery target")

    def test_seeds_extra_and_defaults_the_home_channel(self) -> None:
        self.set_env(SLICK_TOKEN=TOKEN, SLICK_CHANNEL="general")
        seed = adapter._env_enablement() or {}
        self.assertEqual(seed["url"], "http://127.0.0.1:4477")
        self.assertEqual(seed["channel"], "general")
        self.assertEqual(seed["home_channel"], {"chat_id": "general", "name": "general"})
        self.assertNotIn("token", seed, "the token must not be copied into PlatformConfig.extra")

    def test_home_channel_and_allowlist_override(self) -> None:
        self.set_env(
            SLICK_TOKEN=TOKEN,
            SLICK_CHANNEL="general",
            SLICK_HOME_CHANNEL="reports",
            SLICK_ALLOWED_USERS="Fano, ops",
            SLICK_URL="http://127.0.0.1:9999/",
        )
        seed = adapter._env_enablement() or {}
        self.assertEqual(seed["home_channel"]["chat_id"], "reports")
        self.assertEqual(seed["allowed_users"], ["fano", "ops"])
        self.assertEqual(seed["url"], "http://127.0.0.1:9999")


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

class TestConfigHelpers(EnvSandbox):
    def test_url_defaults_env_wins_and_slash_is_trimmed(self) -> None:
        self.assertEqual(adapter.resolve_url(), "http://127.0.0.1:4477")
        self.assertEqual(adapter.resolve_url({"url": "http://box:1234/"}), "http://box:1234")
        self.set_env(SLICK_URL="http://env:5555//")
        self.assertEqual(adapter.resolve_url({"url": "http://box:1234"}), "http://env:5555")

    def test_daemon_file_supplies_the_url_and_token(self) -> None:
        self.write_daemon_file(url="http://127.0.0.1:9999/", token="from-daemon-file")
        self.assertEqual(adapter.resolve_url(), "http://127.0.0.1:9999")
        self.assertEqual(adapter.resolve_token(), "from-daemon-file")
        # Explicit configuration still outranks whatever is running locally.
        self.assertEqual(adapter.resolve_url({"url": "http://elsewhere:1/"}), "http://elsewhere:1")
        self.assertEqual(adapter.resolve_token({"token": "from-config"}), "from-config")
        self.set_env(SLICK_URL="http://env:2", SLICK_TOKEN="from-env")
        self.assertEqual(adapter.resolve_url({"url": "http://elsewhere:1"}), "http://env:2")
        self.assertEqual(adapter.resolve_token({"token": "from-config"}), "from-env")

    def test_a_no_auth_workspace_resolves_to_no_token(self) -> None:
        """``slickd --no-auth`` writes a null token; that is a setup, not a fault."""
        self.write_daemon_file(url="http://127.0.0.1:4477", token=None)
        self.assertEqual(adapter.resolve_token(), "")
        self.assertNotIn("authorization", adapter._headers(adapter.resolve_token()))

    def test_an_unreadable_daemon_file_falls_back_to_defaults(self) -> None:
        self.assertEqual(adapter.resolve_url(), adapter.DEFAULT_URL)
        self.assertEqual(adapter.resolve_token(), "")
        with open(os.path.join(self.slick_home, "daemon.json"), "w", encoding="utf-8") as handle:
            handle.write("{ not json")
        self.assertEqual(adapter.read_daemon_file(), {})
        self.assertEqual(adapter.resolve_url(), adapter.DEFAULT_URL)

    def test_channel_defaults_to_every_channel(self) -> None:
        self.assertEqual(adapter.resolve_channel(), "*")
        self.assertEqual(adapter.resolve_channel({}), "*")
        self.assertEqual(adapter.channel_scope(adapter.resolve_channel()), (None, None))
        self.assertEqual(adapter.resolve_home_channel({}), "", "a wildcard is no target")

    def test_token_and_channel_precedence(self) -> None:
        self.assertEqual(adapter.resolve_token({"token": "from-yaml"}), "from-yaml")
        self.set_env(SLICK_TOKEN="from-env")
        self.assertEqual(adapter.resolve_token({"token": "from-yaml"}), "from-env")
        self.assertEqual(adapter.resolve_channel({"channel": "yaml-chan"}), "yaml-chan")
        self.set_env(SLICK_CHANNEL="env-chan")
        self.assertEqual(adapter.resolve_channel({"channel": "yaml-chan"}), "env-chan")

    def test_home_channel_falls_back_to_the_listen_channel(self) -> None:
        self.assertEqual(adapter.resolve_home_channel({"channel": "general"}), "general")
        self.assertEqual(
            adapter.resolve_home_channel({"channel": "general", "home_channel": "reports"}),
            "reports",
        )
        self.assertEqual(adapter.resolve_home_channel({"channel": "ops,general"}), "ops")
        self.assertEqual(adapter.resolve_home_channel({"channel": "*"}), "")

    def test_allowed_users_parsing(self) -> None:
        self.assertEqual(adapter.parse_allowed_users(None), frozenset())
        self.assertEqual(adapter.parse_allowed_users(""), frozenset())
        self.assertEqual(adapter.parse_allowed_users(" Fano , OPS ,"), frozenset({"fano", "ops"}))
        self.assertEqual(adapter.parse_allowed_users(["Fano", "ops"]), frozenset({"fano", "ops"}))

    def test_channel_scope_modes(self) -> None:
        self.assertEqual(adapter.channel_scope("general"), ("general", frozenset({"general"})))
        self.assertEqual(adapter.channel_scope("*"), (None, None))
        self.assertEqual(adapter.channel_scope(""), (None, None))
        scope, allowed = adapter.channel_scope("general, ops")
        self.assertIsNone(scope)
        self.assertEqual(allowed, frozenset({"general", "ops"}))

    def test_stream_url_scoping(self) -> None:
        self.assertEqual(adapter.stream_url("http://x:1/"), "http://x:1/api/stream")
        self.assertEqual(
            adapter.stream_url("http://x:1", "de v"), "http://x:1/api/stream?channel=de+v"
        )

    def test_numbers_fall_back_on_junk(self) -> None:
        self.assertEqual(adapter._number_setting({}, "k", "SLICK_RETRY_SECONDS", 2.0), 2.0)
        self.assertEqual(adapter._number_setting({"k": "0"}, "k", "SLICK_RETRY_SECONDS", 2.0), 2.0)
        self.assertEqual(adapter._number_setting({"k": "0.5"}, "k", "SLICK_RETRY_SECONDS", 2.0), 0.5)
        self.set_env(SLICK_RETRY_SECONDS="nonsense")
        self.assertEqual(adapter._number_setting({"k": 4}, "k", "SLICK_RETRY_SECONDS", 2.0), 2.0)

    def test_redact_removes_the_token(self) -> None:
        self.set_env(SLICK_TOKEN=TOKEN)
        self.assertNotIn(TOKEN, adapter._redact("failed with " + TOKEN))
        self.assertNotIn("hunter2xyz", adapter._redact("hunter2xyz leaked", "hunter2xyz"))

    def test_json_safe_metadata_drops_unserialisable_values(self) -> None:
        safe = adapter.json_safe_metadata(
            {"ok": 1, "nested": {"deep": [1, "two"]}, "adapter": object(), "long": "x" * 5000}
        )
        # Everything comes back under an underscore: Slick prints any other
        # key as a raw JSON line under the message, and the gateway's own
        # bookkeeping is not something a reader asked to see.
        self.assertEqual(safe["_via"], "hermes")
        self.assertEqual(safe["_ok"], 1)
        self.assertEqual(safe["_nested"], {"deep": [1, "two"]})
        self.assertNotIn("_adapter", safe)
        self.assertEqual(len(safe["_long"]), 2000)
        self.assertTrue(all(key.startswith("_") for key in safe), "nothing shows up under the message")
        json.dumps(safe)  # must round-trip

    def test_json_safe_metadata_leaves_an_underscored_key_alone(self) -> None:
        safe = adapter.json_safe_metadata({"_model": "gpt-5.6-luna"})
        self.assertEqual(safe["_model"], "gpt-5.6-luna")
        self.assertNotIn("__model", safe)

    def test_thread_target_prefers_reply_to(self) -> None:
        self.assertEqual(adapter.thread_target("msg_9", None), "msg_9")
        self.assertEqual(adapter.thread_target(None, {"slick_thread_id": "msg_7"}), "msg_7")
        self.assertEqual(adapter.thread_target(None, {"thread_id": "msg_6"}), "msg_6")
        self.assertIsNone(adapter.thread_target(None, {"unrelated": "x"}))
        self.assertIsNone(adapter.thread_target(None, None))


# ---------------------------------------------------------------------------
# SSE parsing
# ---------------------------------------------------------------------------

class TestSSEParser(unittest.TestCase):
    def test_parses_an_id_and_json_payload(self) -> None:
        parser = adapter.SSEParser()
        self.assertIsNone(parser.feed_line("id: 42\n"))
        self.assertIsNone(parser.feed_line('data: {"type":"message.created"}\n'))
        event = parser.feed_line("\n")
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event["id"], "42")
        self.assertEqual(event["json"], {"type": "message.created"})
        self.assertEqual(parser.last_event_id, "42")

    def test_ignores_comments_and_empty_blocks(self) -> None:
        parser = adapter.SSEParser()
        self.assertIsNone(parser.feed_line(": keepalive\n"))
        self.assertIsNone(parser.feed_line("\n"))
        self.assertIsNone(parser.feed_line("event: ping\n"))
        self.assertIsNone(parser.feed_line("\n"), "a block with no data field dispatches nothing")
        self.assertIsNone(parser.last_event_id)

    def test_multiline_data_is_joined_and_retry_is_seconds(self) -> None:
        parser = adapter.SSEParser()
        events = parser.feed('retry: 2000\ndata: {"a":\ndata: 1}\n\n')
        self.assertEqual(parser.retry, 2.0)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["data"], '{"a":\n1}')
        self.assertEqual(events[0]["json"], {"a": 1})

    def test_stream_ready_frame_carries_no_id(self) -> None:
        # What the hub writes first: `retry:` + `data:` with no `id:` line.
        parser = adapter.SSEParser()
        events = parser.feed('retry: 2000\ndata: {"type":"stream.ready","seq":7}\n\n')
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]["id"])
        self.assertIsNone(parser.last_event_id)

    def test_last_event_id_is_sticky_across_events(self) -> None:
        parser = adapter.SSEParser()
        parser.feed('id: 1\ndata: {"seq":1}\n\n')
        parser.feed('data: {"seq":2}\n\n')
        self.assertEqual(parser.last_event_id, "1")
        parser.feed('id: 3\ndata: {"seq":3}\n\n')
        self.assertEqual(parser.last_event_id, "3")

    def test_crlf_and_fields_without_a_space(self) -> None:
        parser = adapter.SSEParser()
        events = parser.feed('id:9\r\ndata:{"seq":9}\r\n\r\n')
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["id"], "9")
        self.assertEqual(events[0]["json"], {"seq": 9})

    def test_non_json_data_survives_as_text(self) -> None:
        parser = adapter.SSEParser()
        events = parser.feed("data: not json at all\n\n")
        self.assertEqual(events[0]["data"], "not json at all")
        self.assertIsNone(events[0]["json"])


class TestBoundedSet(unittest.TestCase):
    def test_reports_duplicates_and_evicts_oldest(self) -> None:
        seen = adapter._BoundedSet(limit=3)
        self.assertTrue(seen.add("a"))
        self.assertFalse(seen.add("a"))
        seen.add("b")
        seen.add("c")
        seen.add("d")
        self.assertEqual(len(seen), 3)
        self.assertNotIn("a", seen)
        self.assertIn("d", seen)


# ---------------------------------------------------------------------------
# Inbound: filtering, dedup, conversion
# ---------------------------------------------------------------------------

class InboundCase(EnvSandbox, unittest.IsolatedAsyncioTestCase):
    """Drives ``_handle_stream_event`` directly — no sockets involved."""

    async def asyncSetUp(self) -> None:
        self.received: List[Any] = []
        self.adapter = make_adapter()

        async def capture(event: Any) -> None:
            self.received.append(event)

        self.adapter.handle_message = capture  # type: ignore[assignment]

    async def feed(self, payload: Dict[str, Any], event_id: Optional[str] = None) -> None:
        await self.adapter._handle_stream_event(
            {
                "event": "message",
                "id": event_id if event_id is not None else str(payload.get("seq")),
                "data": json.dumps(payload),
                "json": payload,
            }
        )


class TestInboundFiltering(InboundCase):
    async def test_accepts_a_human_message(self) -> None:
        await self.feed(message_event())
        self.assertEqual(len(self.received), 1)

    async def test_ignores_agent_authored_messages(self) -> None:
        await self.feed(message_event(author_kind="agent", author_id="hermes"))
        self.assertEqual(self.received, [])

    async def test_ignores_other_event_types(self) -> None:
        await self.feed({"seq": 5, "type": "agent.typing", "message": None})
        await self.feed({"seq": 6, "type": "channel.created", "channelId": "ch_1"})
        self.assertEqual(self.received, [])

    async def test_ignores_unhydrated_deleted_and_empty_messages(self) -> None:
        unhydrated = message_event(seq=20)
        unhydrated["message"] = None
        await self.feed(unhydrated)
        await self.feed(message_event(seq=21, message_id="msg_del", deleted=True))
        await self.feed(message_event(seq=22, message_id="msg_blank", text="   "))
        self.assertEqual(self.received, [])

    async def test_ignores_frames_that_are_not_json(self) -> None:
        await self.adapter._handle_stream_event(
            {"event": "message", "id": "1", "data": "nope", "json": None}
        )
        self.assertEqual(self.received, [])

    async def test_deduplicates_by_event_seq(self) -> None:
        await self.feed(message_event(seq=30, message_id="msg_a"))
        await self.feed(message_event(seq=30, message_id="msg_b"))
        self.assertEqual(len(self.received), 1)

    async def test_deduplicates_by_message_id(self) -> None:
        await self.feed(message_event(seq=31, message_id="msg_same"))
        await self.feed(message_event(seq=32, message_id="msg_same"))
        self.assertEqual(len(self.received), 1)

    async def test_falls_back_to_the_sse_id_when_seq_is_absent(self) -> None:
        payload = message_event(seq=33, message_id="msg_c")
        payload.pop("seq")
        await self.feed(payload, event_id="33")
        payload_again = message_event(seq=34, message_id="msg_d")
        payload_again.pop("seq")
        await self.feed(payload_again, event_id="33")
        self.assertEqual(len(self.received), 1)

    async def test_ignores_other_channels_when_scoped(self) -> None:
        await self.feed(message_event(seq=40, message_id="m1", channel_slug="secret", channel_id="ch_9"))
        self.assertEqual(self.received, [])
        await self.feed(message_event(seq=41, message_id="m2", channel_slug="general"))
        self.assertEqual(len(self.received), 1)

    async def test_wildcard_scope_accepts_every_channel(self) -> None:
        wide = make_adapter(channel="*")
        received: List[Any] = []

        async def capture(event: Any) -> None:
            received.append(event)

        wide.handle_message = capture  # type: ignore[assignment]
        self.assertIsNone(wide.scope)
        self.assertIsNone(wide.channel_filter)
        await wide._handle_stream_event(
            {"id": "1", "json": message_event(seq=1, channel_slug="anything", channel_id="ch_x")}
        )
        self.assertEqual(len(received), 1)

    async def test_allowlist_blocks_unknown_authors(self) -> None:
        gated = make_adapter(allowed_users="fano")
        received: List[Any] = []

        async def capture(event: Any) -> None:
            received.append(event)

        gated.handle_message = capture  # type: ignore[assignment]
        await gated._handle_stream_event(
            {"id": "1", "json": message_event(seq=1, message_id="m1", author_id="stranger", author_label="Stranger")}
        )
        self.assertEqual(received, [])
        await gated._handle_stream_event(
            {"id": "2", "json": message_event(seq=2, message_id="m2", author_id="fano")}
        )
        self.assertEqual(len(received), 1)

    async def test_own_sent_messages_are_never_read_back(self) -> None:
        self.adapter._own_message_ids.add("msg_echo")
        await self.feed(message_event(seq=50, message_id="msg_echo"))
        self.assertEqual(self.received, [])

    async def test_a_failing_handler_does_not_kill_the_reader(self) -> None:
        async def explode(event: Any) -> None:
            raise RuntimeError("handler blew up")

        self.adapter.handle_message = explode  # type: ignore[assignment]
        await self.feed(message_event(seq=60, message_id="msg_boom"))  # must not raise


class TestInboundConversion(InboundCase):
    async def test_root_message_becomes_a_text_event(self) -> None:
        await self.feed(message_event(seq=70, message_id="msg_root", text="ping"))
        event = self.received[0]
        self.assertEqual(event.text, "ping")
        self.assertIs(event.message_type, MessageType.TEXT)
        self.assertEqual(event.message_id, "msg_root")
        self.assertEqual(event.user_id, "fano")
        self.assertEqual(event.user_name, "Fano")
        self.assertEqual(event.timestamp, datetime.fromtimestamp(1_700_000_000))

        source = event.source
        self.assertEqual(source.chat_id, "general")
        self.assertEqual(source.chat_name, "#general")
        self.assertEqual(source.chat_type, "channel")
        self.assertEqual(source.user_id, "fano")
        self.assertEqual(source.user_name, "Fano")
        self.assertEqual(source.message_id, "msg_root")
        self.assertEqual(
            source.thread_id,
            "msg_root",
            "a root opens a thread, and its own session, so it keys on itself",
        )

    async def test_thread_reply_sets_thread_id(self) -> None:
        await self.feed(
            message_event(
                seq=71, message_id="msg_reply", thread_id="msg_root", parent_id="msg_root"
            )
        )
        event = self.received[0]
        self.assertEqual(event.source.thread_id, "msg_root")
        self.assertEqual(event.metadata["slick_thread_id"], "msg_root")
        self.assertEqual(event.metadata["slick_parent_id"], "msg_root")
        self.assertFalse(event.metadata["slick_is_thread_root"])

    async def test_metadata_carries_the_slick_identifiers(self) -> None:
        await self.feed(message_event(seq=72, message_id="msg_meta"))
        metadata = self.received[0].metadata
        self.assertEqual(metadata["slick_message_id"], "msg_meta")
        self.assertEqual(metadata["slick_channel_id"], "ch_1")
        self.assertEqual(metadata["slick_channel_slug"], "general")
        self.assertEqual(metadata["slick_channel"], "general")
        self.assertEqual(metadata["slick_thread_id"], "msg_meta")
        self.assertEqual(metadata["slick_seq"], 72)
        self.assertEqual(metadata["slick_author_id"], "fano")
        self.assertEqual(metadata["slick_author_kind"], "human")
        self.assertTrue(metadata["slick_is_thread_root"])
        json.dumps(metadata)

    async def test_chat_id_falls_back_to_the_channel_id(self) -> None:
        wide = make_adapter(channel="*")
        received: List[Any] = []

        async def capture(event: Any) -> None:
            received.append(event)

        wide.handle_message = capture  # type: ignore[assignment]
        await wide._handle_stream_event(
            {"id": "1", "json": message_event(seq=1, channel_slug=None, channel_id="ch_only")}
        )
        self.assertEqual(received[0].source.chat_id, "ch_only")
        self.assertEqual(received[0].source.chat_name, "ch_only")

    async def test_dm_channels_are_typed_as_dm(self) -> None:
        self.adapter._channel_kinds["general"] = "dm"
        await self.feed(message_event(seq=73, message_id="msg_dm"))
        self.assertEqual(self.received[0].source.chat_type, "dm")


# ---------------------------------------------------------------------------
# Inbound over a real socket
# ---------------------------------------------------------------------------

class TestStreamOverHttp(EnvSandbox, unittest.IsolatedAsyncioTestCase):
    async def test_reads_events_reconnects_with_last_event_id_and_stops_cleanly(self) -> None:
        server = FakeSlick(
            sse_script=[
                [sse_block(message_event(seq=11, message_id="msg_11", text="first"))],
                [sse_block(message_event(seq=12, message_id="msg_12", text="second"))],
            ]
        )
        self.addCleanup(server.close)

        slick = adapter.SlickAdapter(make_config(server.url))
        received: List[Any] = []
        done = asyncio.Event()

        async def capture(event: Any) -> None:
            received.append(event)
            if len(received) >= 2:
                done.set()

        slick.handle_message = capture  # type: ignore[assignment]

        self.assertTrue(await slick.connect())
        self.assertTrue(slick.is_connected)
        try:
            await asyncio.wait_for(done.wait(), timeout=15)
        finally:
            loop = asyncio.get_event_loop()
            started = loop.time()
            await slick.disconnect()
            elapsed = loop.time() - started
        self.assertLess(elapsed, adapter.DISCONNECT_TIMEOUT, "disconnect must not block")
        self.assertFalse(slick.is_connected)

        self.assertEqual([event.text for event in received], ["first", "second"])
        self.assertEqual(slick._last_event_id, "12")

        streams = server.find("GET", "/api/stream")
        self.assertGreaterEqual(len(streams), 2)
        self.assertEqual(streams[0]["headers"].get("accept"), "text/event-stream")
        self.assertEqual(streams[0]["headers"].get("authorization"), "Bearer " + TOKEN)
        self.assertNotIn("last-event-id", streams[0]["headers"])
        self.assertEqual(streams[1]["headers"].get("last-event-id"), "11")
        self.assertEqual(
            urllib.parse.urlsplit(streams[0]["path"]).query,
            "channel=general",
            "a single configured channel is filtered by the daemon",
        )
        for request in server.requests:
            self.assertNotIn("token", urllib.parse.urlsplit(request["path"]).query)

    async def test_connect_caches_channel_kinds_and_reports_health(self) -> None:
        server = FakeSlick(sse_script=[[]])
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(make_config(server.url))
        self.assertTrue(await slick.connect())
        await slick.disconnect()
        self.assertEqual(slick._channel_kinds.get("fano-dm"), "dm")
        self.assertEqual(slick._channel_kinds.get("general"), "channel")
        self.assertTrue(server.find("GET", "/api/health"))

    async def test_connect_needs_neither_a_token_nor_a_channel(self) -> None:
        """A --no-auth workspace has no token, and the scope defaults to every."""
        server = FakeSlick(sse_script=[[]])
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(PlatformConfig(extra={"url": server.url}))
        self.assertEqual(slick.channel, "*")
        self.assertEqual(slick._token, "")
        self.assertTrue(await slick.connect())
        self.assertTrue(slick.is_connected)
        for _ in range(200):  # the reader opens the stream on the next tick
            if server.stream_connections:
                break
            await asyncio.sleep(0.05)
        await slick.disconnect()
        stream = server.find("GET", "/api/stream")[0]
        self.assertEqual(
            urllib.parse.urlsplit(stream["path"]).query, "", "a wildcard scopes nothing"
        )
        self.assertNotIn("authorization", stream["headers"], "no token, no header")

    async def test_a_health_401_is_fatal_and_names_the_token_var(self) -> None:
        server = FakeSlick(sse_script=[[]])
        server.health_status = 401
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(make_config(server.url))
        with self.assertLogs(adapter.logger, level="ERROR") as logs:
            self.assertFalse(await slick.connect())
        self.assertTrue(any("SLICK_TOKEN" in line for line in logs.output), logs.output)
        self.assertEqual(slick._fatal_error_code, adapter.ERROR_UNAUTHORIZED)
        self.assertNotIn(TOKEN, slick._fatal_error_message)
        self.assertFalse(slick.is_connected)
        self.assertEqual(server.find("GET", "/api/stream"), [])

    async def test_a_wildcard_scope_streams_every_channel(self) -> None:
        server = FakeSlick(
            sse_script=[[sse_block(message_event(channel_slug="idea", channel_id="ch_9"))]]
        )
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(make_config(server.url, channel="*"))
        received: List[Any] = []
        done = asyncio.Event()

        async def capture(event: Any) -> None:
            received.append(event)
            done.set()

        slick.handle_message = capture  # type: ignore[assignment]
        self.assertTrue(await slick.connect())
        try:
            await asyncio.wait_for(done.wait(), timeout=15)
        finally:
            await slick.disconnect()
        self.assertEqual(received[0].source.chat_id, "idea", "a channel not in CHANNELS")

    async def test_connect_refuses_a_channel_the_workspace_does_not_have(self) -> None:
        """A missing channel must fail loudly, not tail a 404 forever."""
        server = FakeSlick(sse_script=[[]])
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(make_config(server.url, channel="ghost"))
        with self.assertLogs(adapter.logger, level="ERROR"):
            self.assertFalse(await slick.connect())
        self.assertFalse(slick.is_connected)
        self.assertEqual(slick._fatal_error_code, adapter.ERROR_CHANNEL_NOT_FOUND)
        self.assertIn("ghost", slick._fatal_error_message)
        self.assertNotIn(TOKEN, slick._fatal_error_message)
        self.assertEqual(server.find("GET", "/api/stream"), [], "must not tail a missing channel")

    async def test_connect_accepts_a_channel_referenced_by_id(self) -> None:
        server = FakeSlick(sse_script=[[]])
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(make_config(server.url, channel="ch_1"))
        self.assertTrue(await slick.connect())
        self.assertTrue(slick.is_connected)
        await slick.disconnect()

    async def test_connect_proceeds_when_the_channel_list_is_unreadable(self) -> None:
        """An unread list cannot disprove a channel — keep the old retry path."""
        server = FakeSlick(sse_script=[[]])
        server.channels_status = 500
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(make_config(server.url, channel="ghost"))
        self.assertTrue(await slick.connect())
        self.assertTrue(slick.is_connected)
        self.assertIsNone(slick._fatal_error_code)
        await slick.disconnect()

    async def test_a_comma_list_survives_one_unknown_channel(self) -> None:
        server = FakeSlick(sse_script=[[]])
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(make_config(server.url, channel="general,ghost"))
        with self.assertLogs(adapter.logger, level="WARNING") as logs:
            self.assertTrue(await slick.connect())
        await slick.disconnect()
        self.assertTrue(any("ghost" in line for line in logs.output), logs.output)
        self.assertIsNone(slick._fatal_error_code)

    async def test_a_stream_404_stops_the_reader_and_says_why(self) -> None:
        """The channel vanished mid-run: give up instead of hiding a dead inbound."""
        server = FakeSlick(sse_script=[[]])
        server.stream_status = 404
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(make_config(server.url))
        with self.assertLogs(adapter.logger, level="ERROR"):
            self.assertTrue(await slick.connect())
            await asyncio.wait_for(slick._stream_task, timeout=10)
        self.assertEqual(server.stream_connections, 1, "one attempt, not an endless retry")
        self.assertEqual(slick._fatal_error_code, adapter.ERROR_CHANNEL_NOT_FOUND)
        self.assertFalse(slick._fatal_error_retryable)
        self.assertFalse(slick.is_connected)
        await slick.disconnect()

    async def test_a_stream_401_stops_the_reader_and_says_why(self) -> None:
        server = FakeSlick(sse_script=[[]])
        server.stream_status = 401
        server.stream_error = {"error": {"code": "unauthorized", "message": "Missing token."}}
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(make_config(server.url))
        with self.assertLogs(adapter.logger, level="ERROR"):
            self.assertTrue(await slick.connect())
            await asyncio.wait_for(slick._stream_task, timeout=10)
        self.assertEqual(server.stream_connections, 1)
        self.assertEqual(slick._fatal_error_code, adapter.ERROR_UNAUTHORIZED)
        self.assertNotIn(TOKEN, slick._fatal_error_message)
        self.assertFalse(slick.is_connected)
        await slick.disconnect()

    async def test_a_transient_stream_failure_still_retries(self) -> None:
        """Only a verdict about the channel is fatal; a 500 keeps reconnecting."""
        server = FakeSlick(sse_script=[[]])
        server.stream_status = 503
        server.stream_error = {"error": {"code": "unavailable", "message": "starting up"}}
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(make_config(server.url))
        self.assertTrue(await slick.connect())
        for _ in range(100):
            if server.stream_connections >= 2:
                break
            await asyncio.sleep(0.05)
        await slick.disconnect()
        self.assertGreaterEqual(server.stream_connections, 2)
        self.assertIsNone(slick._fatal_error_code)

    async def test_get_chat_info_describes_a_channel(self) -> None:
        server = FakeSlick()
        self.addCleanup(server.close)
        slick = adapter.SlickAdapter(make_config(server.url))
        info = await slick.get_chat_info("general")
        self.assertEqual(info["name"], "general")
        self.assertEqual(info["type"], "channel")
        self.assertEqual(info["id"], "ch_1")
        self.assertEqual(info["topic"], "everything")

        dm = await slick.get_chat_info("fano-dm")
        self.assertEqual(dm["type"], "dm")

        missing = await slick.get_chat_info("nope")
        self.assertIn("error", missing)
        self.assertNotIn(TOKEN, missing["error"])
        self.assertEqual(missing["name"], "nope")


# ---------------------------------------------------------------------------
# Outbound
# ---------------------------------------------------------------------------

class TestOutbound(EnvSandbox, unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.server = FakeSlick()
        self.addCleanup(self.server.close)
        self.adapter = adapter.SlickAdapter(make_config(self.server.url))

    def test_build_send_request_picks_the_endpoint(self) -> None:
        url, body = adapter.build_send_request("http://x:1/", "general", "hi")
        self.assertEqual(url, "http://x:1/api/channels/general/messages")
        self.assertEqual(body["text"], "hi")
        self.assertEqual(body["metadata"], {"_via": "hermes"})
        self.assertNotIn("author", body)

        url, body = adapter.build_send_request(
            "http://x:1", "general", "hi", thread_id="msg_7", author={"kind": "agent"}
        )
        self.assertEqual(url, "http://x:1/api/messages/msg_7/replies")
        self.assertEqual(body["author"], {"kind": "agent"})

    def test_build_send_request_escapes_the_reference(self) -> None:
        url, _ = adapter.build_send_request("http://x:1", "we ird/slug", "hi")
        self.assertEqual(url, "http://x:1/api/channels/we%20ird%2Fslug/messages")

    async def test_send_posts_a_root_message(self) -> None:
        result = await self.adapter.send("general", "hello there")
        self.assertTrue(result.success)
        self.assertEqual(result.message_id, "msg_posted")
        self.assertEqual((result.raw_response or {})["message"]["id"], "msg_posted")

        posts = self.server.find("POST", "/api/channels/general/messages")
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["headers"].get("authorization"), "Bearer " + TOKEN)
        self.assertEqual(posts[0]["headers"].get("content-type"), "application/json")
        self.assertEqual(posts[0]["body"]["text"], "hello there")
        self.assertEqual(posts[0]["body"]["metadata"], {"_via": "hermes"})
        self.assertEqual(posts[0]["body"]["author"]["kind"], "agent")
        self.assertEqual(posts[0]["body"]["author"]["id"], "hermes")

    async def test_send_replies_into_a_thread(self) -> None:
        by_reply = await self.adapter.send("general", "in thread", reply_to="msg_root")
        self.assertTrue(by_reply.success)
        by_metadata = await self.adapter.send(
            "general", "also in thread", metadata={"slick_thread_id": "msg_root"}
        )
        self.assertTrue(by_metadata.success)

        replies = self.server.find("POST", "/api/messages/msg_root/replies")
        self.assertEqual(len(replies), 2)
        self.assertEqual(replies[0]["body"]["text"], "in thread")
        self.assertEqual(replies[1]["body"]["metadata"]["_slick_thread_id"], "msg_root")
        self.assertEqual(self.server.find("POST", "/api/channels/"), [])

    async def test_send_falls_back_to_the_home_channel(self) -> None:
        result = await self.adapter.send("", "no chat id given")
        self.assertTrue(result.success)
        self.assertTrue(self.server.find("POST", "/api/channels/general/messages"))

    async def test_sent_ids_are_remembered_for_echo_suppression(self) -> None:
        await self.adapter.send("general", "hello")
        self.assertIn("msg_posted", self.adapter._own_message_ids)

    async def test_server_error_is_retryable(self) -> None:
        self.server.post_status = 503
        result = await self.adapter.send("general", "hello")
        self.assertFalse(result.success)
        self.assertTrue(result.retryable)
        self.assertEqual(result.error_kind, "transient")
        self.assertIn("503", result.error or "")
        self.assertNotIn(TOKEN, result.error or "")

    async def test_missing_channel_is_not_retryable(self) -> None:
        self.server.post_status = 404
        self.server.post_error = {"error": {"code": "not_found", "message": "No channel gone"}}
        result = await self.adapter.send("gone", "hello")
        self.assertFalse(result.success)
        self.assertFalse(result.retryable)
        self.assertEqual(result.error_kind, "not_found")
        self.assertIn("No channel gone", result.error or "")

    async def test_bad_token_is_reported_as_forbidden(self) -> None:
        self.server.post_status = 401
        self.server.post_error = {"error": {"code": "unauthorized", "message": "Missing token."}}
        result = await self.adapter.send("general", "hello")
        self.assertFalse(result.success)
        self.assertFalse(result.retryable)
        self.assertEqual(result.error_kind, "forbidden")

    async def test_network_failure_is_retryable_and_hides_the_token(self) -> None:
        offline = adapter.SlickAdapter(
            make_config("http://127.0.0.1:{}".format(free_port()), token=TOKEN)
        )
        result = await offline.send("general", "hello")
        self.assertFalse(result.success)
        self.assertTrue(result.retryable)
        self.assertEqual(result.error_kind, "transient")
        self.assertNotIn(TOKEN, result.error or "")
        self.assertIn("unreachable", (result.error or "").lower())

    async def test_send_without_a_target_fails_fast(self) -> None:
        homeless = adapter.SlickAdapter(PlatformConfig(extra={"token": TOKEN, "url": self.server.url}))
        result = await homeless.send("", "nowhere to go")
        self.assertFalse(result.success)
        self.assertEqual(self.server.requests, [])


class TestTyping(EnvSandbox, unittest.IsolatedAsyncioTestCase):
    """The indicator: which thread it lands on, and that it always goes out."""

    def setUp(self) -> None:
        super().setUp()
        self.server = FakeSlick()
        self.addCleanup(self.server.close)
        self.adapter = adapter.SlickAdapter(make_config(self.server.url))

    def typings(self) -> List[Dict[str, Any]]:
        return [entry["body"] for entry in self.server.find("POST", "/api/typing")]

    async def turn(self, payload: Dict[str, Any]) -> None:
        """Answer one inbound message the way the gateway does: typing around it."""

        async def handle(event: Any) -> None:
            await self.adapter.send_typing(event.source.chat_id)
            await self.adapter.stop_typing(event.source.chat_id)

        self.adapter.handle_message = handle  # type: ignore[assignment]
        await self.adapter._handle_stream_event(
            {"event": "message", "id": str(payload.get("seq")), "data": "", "json": payload}
        )

    async def test_a_root_message_lights_up_its_own_thread(self) -> None:
        await self.turn(message_event(message_id="msg_root"))
        self.assertEqual([t["threadId"] for t in self.typings()], ["msg_root", "msg_root"])

    async def test_a_reply_lights_up_the_thread_it_is_in(self) -> None:
        await self.turn(
            message_event(seq=12, message_id="msg_reply", thread_id="msg_root", parent_id="msg_root")
        )
        self.assertEqual([t["threadId"] for t in self.typings()], ["msg_root", "msg_root"])

    async def test_on_then_off_in_that_order_as_the_agent(self) -> None:
        await self.turn(message_event(message_id="msg_root"))
        sent = self.typings()
        self.assertEqual([t["on"] for t in sent], [True, False])
        self.assertEqual({t["agentId"] for t in sent}, {"hermes"})

    async def test_two_threads_answered_at_once_do_not_borrow_each_other(self) -> None:
        # Both turns are in flight together; each context variable is the
        # task's own, so neither sees the other's target.
        started = asyncio.Event()

        async def slow(event: Any) -> None:
            await self.adapter.send_typing(event.source.chat_id)
            started.set()
            await asyncio.sleep(0.05)
            await self.adapter.stop_typing(event.source.chat_id)

        self.adapter.handle_message = slow  # type: ignore[assignment]
        first = asyncio.create_task(
            self.adapter._handle_stream_event(
                {"event": "message", "id": "1", "data": "", "json": message_event(seq=1, message_id="msg_a")}
            )
        )
        await started.wait()
        await self.adapter._handle_stream_event(
            {"event": "message", "id": "2", "data": "", "json": message_event(seq=2, message_id="msg_b")}
        )
        await first
        by_thread = {}
        for entry in self.typings():
            by_thread.setdefault(entry["threadId"], []).append(entry["on"])
        self.assertEqual(by_thread, {"msg_a": [True, False], "msg_b": [True, False]})

    async def test_metadata_names_the_thread_when_it_has_one(self) -> None:
        # {"thread_id": …} is what the gateway itself passes
        # (_thread_metadata_for_target); slick_thread_id is our own inbound key.
        await self.adapter.send_typing("general", {"thread_id": "msg_from_gateway"})
        await self.adapter.send_typing("general", {"slick_thread_id": "msg_elsewhere"})
        self.assertEqual(
            [t["threadId"] for t in self.typings()], ["msg_from_gateway", "msg_elsewhere"]
        )

    async def test_the_gateway_still_passes_a_thread_to_typing(self) -> None:
        """The supply chain for the metadata path, read from Hermes itself."""
        run = HERMES_ROOT / "gateway" / "run.py"
        if not run.is_file():
            self.skipTest("no Hermes checkout to read")
        source = run.read_text(encoding="utf-8", errors="replace")
        self.assertIn("send_typing(ctx.source.chat_id, metadata=ctx._progress_metadata)", source)
        self.assertIn('metadata: Dict[str, Any] = {"thread_id": thread_id}', source)

    async def test_outside_a_turn_there_is_nothing_to_point_at(self) -> None:
        await self.adapter.send_typing("general")
        await self.adapter.stop_typing("general")
        self.assertEqual(self.typings(), [])

    async def test_another_chat_does_not_borrow_this_turn_s_thread(self) -> None:
        seen: List[Any] = []

        async def handle(event: Any) -> None:
            seen.append(event)
            await self.adapter.send_typing("some-other-channel")

        self.adapter.handle_message = handle  # type: ignore[assignment]
        await self.adapter._handle_stream_event(
            {"event": "message", "id": "9", "data": "", "json": message_event(message_id="msg_root")}
        )
        self.assertEqual(len(seen), 1)
        self.assertEqual(self.typings(), [])

    async def test_a_daemon_that_refuses_costs_nothing(self) -> None:
        self.server.post_status = 500
        await self.turn(message_event(message_id="msg_root"))
        # It tried, and it did not raise into the gateway.
        self.assertEqual(len(self.server.find("POST", "/api/typing")), 2)


class TestModelBadge(EnvSandbox, unittest.IsolatedAsyncioTestCase):
    """``metadata._model`` is what Slick badges an agent message with."""

    def setUp(self) -> None:
        super().setUp()
        self.server = FakeSlick()
        self.addCleanup(self.server.close)
        self.slick = adapter.SlickAdapter(make_config(self.server.url))
        self.slick.gateway_runner = FakeRunner()

    def turn_end(self, **context: Any) -> Dict[str, Any]:
        payload = {"platform": "slick", "chat_id": "general", "model": "gpt-5.6-luna"}
        payload.update(context)
        return payload

    async def posted_metadata(self) -> Dict[str, Any]:
        body = self.server.find("POST", "/api/channels/")[-1]["body"]
        return (body or {}).get("metadata") or {}

    def _state_db(self, rows: Dict[str, str]) -> str:
        """A stand-in for Hermes' session store, with the rows this test needs."""
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, True)
        store = os.path.join(home, "state.db")
        db = sqlite3.connect(store)
        db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, model_config TEXT)")
        for session_id, config in rows.items():
            db.execute("INSERT INTO sessions VALUES (?, ?)", (session_id, config))
        db.commit()
        db.close()
        return store

    def test_session_effort_reads_the_level_hermes_resolved(self) -> None:
        store = self._state_db(
            {
                "s-max": '{"reasoning_config": {"enabled": true, "effort": "max"}}',
                "s-off": '{"reasoning_config": {"enabled": false}}',
                "s-none": None,
            }
        )
        with unittest.mock.patch.object(adapter, "HERMES_STATE_DB", store):
            self.assertEqual(adapter.session_effort("s-max"), "max")
            self.assertEqual(adapter.session_effort("s-off"), "", "reasoning off records no level")
            self.assertEqual(adapter.session_effort("s-none"), "")
            self.assertEqual(adapter.session_effort("never-existed"), "")
            self.assertEqual(adapter.session_effort(""), "")
            self.assertEqual(adapter.session_effort(None), "")

    def test_a_session_that_recorded_nothing_falls_back_to_what_is_set(self) -> None:
        """A row with no reasoning_config at all is a gap, not an answer.

        Hermes does not always write the block — a gateway session can land
        with only its runtime in `model_config` — and a badge that goes quiet
        because of that is reporting on Hermes' bookkeeping rather than on the
        reply. Where nothing was recorded, today's setting is what is left.
        """
        store = self._state_db(
            {
                "s-recorded": '{"reasoning_config": {"enabled": true, "effort": "max"}}',
                "s-flat": '{"reasoning_config": {"enabled": false}}',
                "s-gap": '{"gateway_runtime": {"provider": "openai-codex"}}',
            }
        )
        with unittest.mock.patch.object(adapter, "HERMES_STATE_DB", store):
            with unittest.mock.patch.object(adapter, "config_effort", return_value="high"):
                # A row that says something is believed, including when what it
                # says is "no level" — that is resolved, not missing.
                self.assertEqual(adapter.effort_for_turn("s-recorded", "m"), "max")
                self.assertEqual(adapter.effort_for_turn("s-flat", "m"), "")
                # A row that says nothing falls through to the config.
                self.assertEqual(adapter.effort_for_turn("s-gap", "m"), "high")
                self.assertEqual(adapter.effort_for_turn("never-existed", "m"), "high")

    def test_config_effort_never_raises_and_honours_disabled(self) -> None:
        """The fallback runs inside Hermes, but a badge is not worth a crash."""
        # No hermes_cli/hermes_constants on the path under test → silent "".
        with unittest.mock.patch.dict("sys.modules", {"hermes_cli.config": None}):
            self.assertEqual(adapter.config_effort("m"), "")
        fake = unittest.mock.Mock(return_value={"enabled": False, "effort": "max"})
        with unittest.mock.patch.dict(
            "sys.modules",
            {
                "hermes_cli.config": unittest.mock.Mock(load_config=lambda: {}),
                "hermes_constants": unittest.mock.Mock(resolve_reasoning_config=fake),
            },
        ):
            self.assertEqual(adapter.config_effort("m"), "", "thinking off is not a level")
        fake = unittest.mock.Mock(return_value={"enabled": True, "effort": "xhigh"})
        with unittest.mock.patch.dict(
            "sys.modules",
            {
                "hermes_cli.config": unittest.mock.Mock(load_config=lambda: {}),
                "hermes_constants": unittest.mock.Mock(resolve_reasoning_config=fake),
            },
        ):
            self.assertEqual(adapter.config_effort("m"), "xhigh")

    def test_a_missing_or_broken_store_costs_a_badge_and_nothing_else(self) -> None:
        with unittest.mock.patch.object(adapter, "HERMES_STATE_DB", "/nowhere/state.db"):
            self.assertEqual(adapter.session_effort("s-max"), "")
        store = self._state_db({})
        with unittest.mock.patch.object(adapter, "HERMES_STATE_DB", store):
            db = sqlite3.connect(store)
            db.execute("DROP TABLE sessions")
            db.commit()
            db.close()
            self.assertEqual(adapter.session_effort("s-max"), "", "a renamed table is not a crash")

    async def test_the_badge_says_how_hard_it_thought(self) -> None:
        store = self._state_db({"s-1": '{"reasoning_config": {"enabled": true, "effort": "xhigh"}}'})
        self.assertTrue(await self.slick.connect())
        with unittest.mock.patch.object(adapter, "HERMES_STATE_DB", store):
            await self.slick.gateway_runner.hooks.emit("agent:end", self.turn_end(session_id="s-1"))
            await self.slick.send("general", "hi")
        posted = await self.posted_metadata()
        self.assertEqual(posted.get("_model"), "gpt-5.6-luna")
        self.assertEqual(posted.get("_effort"), "xhigh")
        await self.slick.disconnect()

    async def test_a_turn_with_no_recorded_level_is_badged_with_the_model_alone(self) -> None:
        self.assertTrue(await self.slick.connect())
        with unittest.mock.patch.object(adapter, "HERMES_STATE_DB", "/nowhere/state.db"):
            await self.slick.gateway_runner.hooks.emit("agent:end", self.turn_end(session_id="s-1"))
            await self.slick.send("general", "hi")
        posted = await self.posted_metadata()
        self.assertEqual(posted.get("_model"), "gpt-5.6-luna")
        self.assertNotIn("_effort", posted, "no level is better than a guessed one")
        await self.slick.disconnect()

    def test_normalise_model_keeps_ids_and_shortens_paths(self) -> None:
        self.assertEqual(adapter.normalise_model("gpt-5.6-luna"), "gpt-5.6-luna")
        self.assertEqual(adapter.normalise_model("  claude-opus-5  "), "claude-opus-5")
        self.assertEqual(
            adapter.normalise_model("/home/fano/.cache/hub/Qwen3.8-27B-UD-IQ4_XS.gguf"),
            "Qwen3.8-27B-UD-IQ4_XS.gguf",
        )
        self.assertEqual(
            adapter.normalise_model("C:\\LLM\\models\\Qwen3.8-27B-UD-Q4_K_M.gguf"),
            "Qwen3.8-27B-UD-Q4_K_M.gguf",
        )
        self.assertEqual(adapter.normalise_model(None), "")
        self.assertEqual(adapter.normalise_model("provider/model"), "model")

    def test_memo_is_bounded_and_newest_wins(self) -> None:
        memo = adapter._ModelMemo(limit=2)
        memo.put("a", "one")
        memo.put("b", "two")
        memo.put("c", "three")
        self.assertIsNone(memo.get("a"), "oldest is evicted")
        self.assertEqual(memo.get("c"), "three")
        memo.put("b", "again")
        self.assertEqual(memo.get("b"), "again")
        self.assertEqual(len(memo), 2)
        memo.put("d", "")
        self.assertIsNone(memo.get("d"), "an empty model is not worth remembering")
        self.assertEqual(memo.get("nope", "b"), "again", "falls through to the next key")

    def test_the_memo_slot_is_a_chat_and_a_thread(self) -> None:
        self.assertNotEqual(
            adapter.memo_key("general", "msg_a"), adapter.memo_key("general", "msg_b")
        )
        self.assertEqual(adapter.memo_key("general", None), adapter.memo_key("general", ""))
        self.assertEqual(adapter.memo_key(" general ", " msg_a "), adapter.memo_key("general", "msg_a"))
        self.assertEqual(adapter.memo_key(None, None), "", "nothing to remember it by")
        memo = adapter._ModelMemo()
        memo.put(adapter.memo_key("general", "msg_a"), "model-a")
        memo.put(adapter.memo_key("general", "msg_b"), "model-b")
        self.assertEqual(len(memo), 2, "one channel, two live threads, two slots")
        self.assertEqual(memo.get(adapter.memo_key("general", "msg_a")), "model-a")

    async def test_two_threads_of_one_channel_do_not_share_a_badge(self) -> None:
        """The bug the pair-key exists for.

        Keyed on the chat alone, whichever turn ended second overwrote the
        first, and both replies went out badged with the second turn's model.
        The typing indicator has routed per thread since it was written; the
        badge was the half that did not.
        """
        self.assertTrue(await self.slick.connect())
        for thread_id, model in (("msg_a", "model-a"), ("msg_b", "model-b")):
            await self.slick.gateway_runner.hooks.emit(
                "agent:end", self.turn_end(thread_id=thread_id, model=model)
            )
        await self.slick.send("general", "first", reply_to="msg_a")
        await self.slick.send("general", "second", reply_to="msg_b")
        replies = self.server.find("POST", "/api/messages/")[-2:]
        self.assertEqual(
            [reply["body"]["metadata"].get("_model") for reply in replies],
            ["model-a", "model-b"],
        )
        await self.slick.disconnect()

    async def test_the_turn_on_the_stack_names_the_thread_agent_end_did(self) -> None:
        """A turn whose hook context carried no thread still badges correctly."""
        self.assertTrue(await self.slick.connect())
        target = {"chat_id": "general", "thread_id": "msg_root"}
        token = adapter._TURN_TARGET.set(target)
        try:
            await self.slick.gateway_runner.hooks.emit("agent:end", self.turn_end())
            await self.slick.send("general", "hi")
        finally:
            adapter._TURN_TARGET.reset(token)
        self.assertEqual((await self.posted_metadata()).get("_model"), "gpt-5.6-luna")
        await self.slick.disconnect()

    async def test_a_reply_carries_the_model_that_answered(self) -> None:
        self.assertTrue(await self.slick.connect())
        await self.slick.gateway_runner.hooks.emit("agent:end", self.turn_end())
        result = await self.slick.send("general", "hi")
        self.assertTrue(result.success)
        self.assertEqual((await self.posted_metadata()).get("_model"), "gpt-5.6-luna")
        await self.slick.disconnect()

    async def test_another_platforms_turn_never_lands_on_a_slick_message(self) -> None:
        self.assertTrue(await self.slick.connect())
        await self.slick.gateway_runner.hooks.emit(
            "agent:end", self.turn_end(platform="discord", model="some-other-model")
        )
        await self.slick.send("general", "hi")
        self.assertNotIn("_model", await self.posted_metadata())
        await self.slick.disconnect()

    async def test_a_turn_we_never_saw_end_is_not_guessed_at(self) -> None:
        self.assertTrue(await self.slick.connect())
        await self.slick.send("general", "hi")
        self.assertNotIn("_model", await self.posted_metadata())
        await self.slick.disconnect()

    async def test_an_explicit_model_in_the_metadata_wins(self) -> None:
        self.assertTrue(await self.slick.connect())
        await self.slick.gateway_runner.hooks.emit("agent:end", self.turn_end())
        await self.slick.send("general", "hi", metadata={"_model": "already-known"})
        self.assertEqual((await self.posted_metadata()).get("_model"), "already-known")
        await self.slick.disconnect()

    async def test_the_stamp_does_not_disturb_thread_routing_or_other_keys(self) -> None:
        self.assertTrue(await self.slick.connect())
        await self.slick.gateway_runner.hooks.emit("agent:end", self.turn_end())
        await self.slick.send(
            "general", "hi", reply_to="msg_root", metadata={"note": "keep me"}
        )
        reply = self.server.find("POST", "/api/messages/")[-1]
        self.assertIn("msg_root", reply["path"], "still routed into the thread")
        self.assertEqual(reply["body"]["metadata"].get("_note"), "keep me")
        self.assertEqual(reply["body"]["metadata"].get("_model"), "gpt-5.6-luna")
        await self.slick.disconnect()

    async def test_a_path_shaped_model_is_badged_readably(self) -> None:
        self.assertTrue(await self.slick.connect())
        await self.slick.gateway_runner.hooks.emit(
            "agent:end", self.turn_end(model="C:\\LLM\\models\\Qwen3.8-27B-UD-IQ4_XS.gguf")
        )
        await self.slick.send("general", "hi")
        self.assertEqual(
            (await self.posted_metadata()).get("_model"), "Qwen3.8-27B-UD-IQ4_XS.gguf"
        )
        await self.slick.disconnect()

    async def test_reconnecting_does_not_stack_handlers(self) -> None:
        handlers = self.slick.gateway_runner.hooks._handlers
        for _ in range(3):
            self.assertTrue(await self.slick.connect())
            self.assertEqual(len(handlers.get("agent:end", [])), 1)
            await self.slick.disconnect()
            self.assertEqual(handlers.get("agent:end", []), [])

    async def test_a_gateway_without_a_hook_registry_still_sends(self) -> None:
        """The badge is a nicety: never let it break a connect or a delivery."""
        for runner in (None, object(), types.SimpleNamespace(hooks=object())):
            slick = adapter.SlickAdapter(make_config(self.server.url))
            if runner is not None:
                slick.gateway_runner = runner
            self.assertTrue(await slick.connect())
            self.assertFalse(slick._turn_model_hooked)
            self.assertTrue((await slick.send("general", "hi")).success)
            self.assertNotIn("_model", await self.posted_metadata())
            await slick.disconnect()


# ---------------------------------------------------------------------------
# Live progress
# ---------------------------------------------------------------------------

class TestStepTitle(unittest.TestCase):
    """The wording comes from Hermes, and survives Hermes moving it."""

    def test_hermes_own_label_is_used_when_it_is_there(self) -> None:
        with unittest.mock.patch.object(
            adapter, "build_tool_label", lambda name, args, max_len=None: "Searching the web for slick"
        ):
            self.assertEqual(
                adapter.step_title("web_search", {"query": "slick"}),
                "Searching the web for slick",
            )

    def test_a_status_phrase_loses_the_display_name_it_was_written_for(self) -> None:
        with unittest.mock.patch.object(adapter, "build_tool_label", lambda *a, **k: None), \
             unittest.mock.patch.object(
                 adapter, "build_status_phrase", lambda *a, **k: "is running tests.sh"
             ):
            self.assertEqual(adapter.step_title("run_terminal_cmd", {}), "Running tests.sh")

    def test_the_raw_tool_name_is_still_true(self) -> None:
        with unittest.mock.patch.object(adapter, "build_tool_label", None), \
             unittest.mock.patch.object(adapter, "build_status_phrase", None):
            self.assertEqual(adapter.step_title("web_search", {"query": "slick"}), "web_search")
            self.assertEqual(adapter.step_title(None, None), "tool")

    def test_a_label_that_raises_does_not_reach_the_turn(self) -> None:
        def moved(*args: Any, **kwargs: Any) -> str:
            raise RuntimeError("build_tool_label moved")

        with unittest.mock.patch.object(adapter, "build_tool_label", moved), \
             unittest.mock.patch.object(adapter, "build_status_phrase", moved):
            self.assertEqual(adapter.step_title("web_search", {}), "web_search")


class TestThinkLog(unittest.TestCase):
    """The blob: id-keyed, append-only, and never left spinning."""

    def test_a_step_is_updated_in_place_rather_than_appended_twice(self) -> None:
        log = adapter._ThinkLog()
        log.step("c1", title="Searching the web…", status="in_progress")
        log.step("c1", title="Searching the web", status="complete")
        blob = log.blob()
        self.assertEqual([step["id"] for step in blob["s"]], ["c1"])
        self.assertEqual(blob["s"][0]["st"], "complete")
        self.assertEqual(blob["s"][0]["t"], "Searching the web")

    def test_the_collapsed_line_follows_whatever_is_running(self) -> None:
        log = adapter._ThinkLog()
        log.title(adapter.STREAM_START_TITLE)
        self.assertEqual(log.blob()["t"], adapter.STREAM_START_TITLE)
        log.step("c1", title="Reading paths.js…", status="in_progress")
        self.assertEqual(log.blob()["t"], "Reading paths.js…")
        log.step("c1", title="Reading paths.js", status="complete")
        self.assertEqual(log.blob()["t"], "Reading paths.js", "a finished box still says what it did")

    def test_settling_leaves_nothing_spinning(self) -> None:
        log = adapter._ThinkLog()
        log.step("c1", title="Reading…", status="in_progress")
        log.step("c2", title="Writing…")
        log.settle(adapter.THINK_DONE)
        blob = log.blob()
        self.assertEqual(blob["p"], "done")
        self.assertEqual([step["st"] for step in blob["s"]], ["complete", "complete"])

    def test_settling_on_an_error_says_which_steps_never_finished(self) -> None:
        log = adapter._ThinkLog()
        log.step("c1", title="Reading", status="complete")
        log.step("c2", title="Writing…", status="in_progress")
        log.settle(adapter.THINK_ERROR)
        self.assertEqual([step["st"] for step in log.blob()["s"]], ["complete", "error"])

    def test_reasoning_is_one_growing_step_that_keeps_the_newest_words(self) -> None:
        log = adapter._ThinkLog()
        for _ in range(50):
            log.reason("x" * 100)
        log.reason(" and finally this")
        blob = log.blob()
        self.assertEqual([step["id"] for step in blob["s"]], [adapter.REASONING_STEP_ID])
        output = blob["s"][0]["o"]
        self.assertLessEqual(len(output), adapter.THINK_OUTPUT_LIMIT)
        self.assertTrue(output.endswith(" and finally this"))
        self.assertTrue(output.startswith("…"), "the trimmed head is marked")

    def test_the_step_cap_is_slick_s_own(self) -> None:
        log = adapter._ThinkLog()
        for index in range(adapter.THINK_STEP_LIMIT + 10):
            log.step("c{}".format(index), title="step", status="complete")
        self.assertEqual(len(log.blob()["s"]), adapter.THINK_STEP_LIMIT)

    def test_finishing_reasoning_never_invents_a_step(self) -> None:
        log = adapter._ThinkLog()
        log.finish_reasoning()
        self.assertEqual(log.blob()["s"], [])


class TestDeltaFlusher(unittest.TestCase):
    """Buffer, coalesce, and never make the caller wait on a socket."""

    def flusher(self, deliver: Any, interval: float = 30) -> Any:
        # A tick far in the future: every test below drives ``flush`` itself,
        # so nothing here ever waits on a clock.
        made = adapter._DeltaFlusher(deliver, interval=interval)
        self.addCleanup(made.close)
        return made

    def test_a_tick_coalesces_a_thread_into_one_call(self) -> None:
        sent: List[Any] = []
        flusher = self.flusher(lambda thread_id, text, think, done: sent.append((thread_id, text)))
        for chunk in ("Hel", "lo ", "there"):
            flusher.push("msg_root", text=chunk)
        flusher.flush()
        self.assertEqual(sent, [("msg_root", "Hello there")])

    def test_threads_are_never_merged(self) -> None:
        sent: List[Any] = []
        flusher = self.flusher(lambda thread_id, text, think, done: sent.append((thread_id, text)))
        flusher.push("msg_a", text="one")
        flusher.push("msg_b", text="two")
        flusher.push("msg_a", text=" more")
        flusher.flush()
        self.assertEqual(sorted(sent), [("msg_a", "one more"), ("msg_b", "two")])

    def test_the_newest_blob_says_everything_the_ones_it_replaces_did(self) -> None:
        sent: List[Any] = []
        flusher = self.flusher(lambda thread_id, text, think, done: sent.append(think))
        flusher.push("msg_root", think={"p": "streaming", "s": [{"id": "c1"}]})
        flusher.push("msg_root", think={"p": "streaming", "s": [{"id": "c1"}, {"id": "c2"}]})
        flusher.flush()
        self.assertEqual(len(sent), 1)
        self.assertEqual([step["id"] for step in sent[0]["s"]], ["c1", "c2"])

    def test_nothing_buffered_is_nothing_sent(self) -> None:
        sent: List[Any] = []
        flusher = self.flusher(lambda *args: sent.append(args))
        flusher.flush()
        flusher.push("", text="nowhere")
        flusher.flush()
        self.assertEqual(sent, [])

    def test_push_never_waits_on_the_request_it_causes(self) -> None:
        """The whole reason this class exists.

        The observer hands a callback one thread draining a bounded queue; a
        callback that blocks on a socket loses every delta that arrives while
        it is open, and says so only in a debug log.
        """
        started = threading.Event()
        release = threading.Event()
        sent: List[str] = []

        def deliver(thread_id: str, text: str, think: Any, done: bool) -> None:
            started.set()
            release.wait(5)
            sent.append(text)

        flusher = self.flusher(deliver)
        self.addCleanup(release.set)
        flusher.push("msg_root", text="first")
        worker = threading.Thread(target=flusher.flush, daemon=True)
        worker.start()
        self.assertTrue(started.wait(5), "the delivery never began")

        began = time.monotonic()
        for _ in range(500):
            flusher.push("msg_root", text="x")
        elapsed = time.monotonic() - began
        self.assertLess(elapsed, 1.0, "push waited on the socket ({}s)".format(elapsed))

        release.set()
        worker.join(timeout=5)
        flusher.flush()
        self.assertEqual(sent, ["first", "x" * 500])

    def test_the_buffer_is_bounded_and_the_newest_text_survives(self) -> None:
        sent: List[str] = []
        flusher = self.flusher(lambda thread_id, text, think, done: sent.append(text))
        chunk = "y" * 1000
        for _ in range(int(adapter.DELTA_BUFFER_LIMIT / 1000) + 50):
            flusher.push("msg_root", text=chunk)
        flusher.push("msg_root", text="the last word")
        flusher.flush()
        self.assertLessEqual(len(sent[0]), adapter.DELTA_BUFFER_LIMIT + len(chunk))
        self.assertTrue(sent[0].endswith("the last word"))

    def test_a_delivery_that_raises_does_not_stop_the_next_one(self) -> None:
        seen: List[str] = []

        def deliver(thread_id: str, text: str, think: Any, done: bool) -> None:
            seen.append(thread_id)
            if thread_id == "msg_a":
                raise RuntimeError("the daemon fell over")

        flusher = self.flusher(deliver)
        flusher.push("msg_a", text="one")
        flusher.push("msg_b", text="two")
        flusher.flush()
        self.assertEqual(seen, ["msg_a", "msg_b"])

    def test_the_timer_thread_starts_itself_and_sends(self) -> None:
        sent: List[str] = []
        flusher = self.flusher(
            lambda thread_id, text, think, done: sent.append(text), interval=0.01
        )
        flusher.push("msg_root", text="unattended")
        deadline = time.monotonic() + 5
        while not sent and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(sent, ["unattended"])


class TestLiveProgress(EnvSandbox, unittest.IsolatedAsyncioTestCase):
    """What reaches Slick's two ephemeral routes — and what must not."""

    def setUp(self) -> None:
        super().setUp()
        self.server = FakeSlick()
        self.addCleanup(self.server.close)
        self.slick = adapter.SlickAdapter(make_config(self.server.url))
        self.bridge = adapter._STREAM_BRIDGE
        # The 404 latch is process-wide by design; a test must not leave one on.
        self.addCleanup(self.bridge._missing.clear)
        # A timer far enough away that it never fires here.  These tests drive
        # the tick themselves: a background flush racing an assertion is the
        # difference between testing the bridge and testing the clock, and a
        # request in flight while the test reads the server's log looks exactly
        # like a request that was never made.
        self.flusher = adapter._DeltaFlusher(self.bridge._deliver, interval=3600)
        original, self.bridge._flusher = self.bridge._flusher, self.flusher
        self.addCleanup(setattr, self.bridge, "_flusher", original)
        self.addCleanup(self.flusher.close)
        self.bridge.attach(self.slick)
        self.addCleanup(self.bridge.detach, self.slick)

    def tick(self) -> None:
        """Do the timer thread's job here, so no test waits on a clock."""
        self.flusher.flush()

    def deltas(self) -> List[Any]:
        return [entry["body"] for entry in self.server.find("POST", "/api/stream/delta")]

    def thinkings(self) -> List[Any]:
        return [entry["body"] for entry in self.server.find("POST", "/api/thinking")]

    @contextlib.contextmanager
    def turn(self, thread_id: str = "msg_root", chat_id: str = "general"):
        """One live turn, both ways a callback can find it."""
        target = {"chat_id": chat_id, "thread_id": thread_id}
        self.bridge.turn_started(target)
        token = adapter._TURN_TARGET.set(target)
        try:
            yield target
        finally:
            adapter._TURN_TARGET.reset(token)
            self.bridge.turn_finished(target)

    def test_a_thread_s_deltas_arrive_as_one_request(self) -> None:
        with self.turn():
            for chunk in ("Look", "ing ", "it up"):
                self.bridge.on_stream_delta(surface="slick", delta=chunk, kind="text")
            self.tick()
        sent = self.deltas()
        self.assertEqual([body["text"] for body in sent], ["Looking it up"])
        self.assertEqual(sent[0]["agentId"], "hermes")
        self.assertEqual(sent[0]["threadId"], "msg_root")

    def test_another_surface_is_none_of_our_business(self) -> None:
        with self.turn():
            self.bridge.on_stream_start(surface="telegram")
            self.bridge.on_stream_delta(surface="telegram", delta="hello", kind="text")
            self.bridge.on_stream_end(surface="telegram", final_text="hello", finished=True, error=None)
            self.tick()
        self.assertEqual(self.deltas(), [])
        self.assertEqual(self.thinkings(), [])

    def test_a_tool_call_opens_a_step_and_closes_it(self) -> None:
        with self.turn():
            self.bridge.pre_tool_call(
                tool_name="web_search", args={"query": "slick"}, tool_call_id="c1"
            )
            self.tick()
            opened = self.thinkings()[-1]
            self.bridge.post_tool_call(
                tool_name="web_search", args={"query": "slick"}, tool_call_id="c1", status="ok"
            )
            self.tick()
        closed = self.thinkings()[-1]
        self.assertEqual(opened["threadId"], "msg_root")
        self.assertEqual([step["id"] for step in opened["think"]["s"]], ["c1"])
        self.assertEqual(opened["think"]["s"][0]["st"], "in_progress")
        self.assertTrue(opened["think"]["s"][0]["t"].endswith("…"))
        self.assertEqual([step["id"] for step in closed["think"]["s"]], ["c1"])
        self.assertEqual(closed["think"]["s"][0]["st"], "complete")
        self.assertFalse(closed["think"]["s"][0]["t"].endswith("…"))

    def test_a_tool_that_failed_says_so_and_says_why(self) -> None:
        with self.turn():
            self.bridge.pre_tool_call(tool_name="read_file", args={}, tool_call_id="c1")
            self.bridge.post_tool_call(
                tool_name="read_file",
                args={},
                tool_call_id="c1",
                status="error",
                error_message="No such file",
            )
            self.tick()
        step = self.thinkings()[-1]["think"]["s"][0]
        self.assertEqual(step["st"], "error")
        self.assertEqual(step["o"], "No such file")

    def test_pre_tool_call_never_answers_with_a_directive(self) -> None:
        """A dict from this hook can veto the call; an observer must not."""
        with self.turn():
            self.assertIsNone(
                self.bridge.pre_tool_call(tool_name="web_search", args={}, tool_call_id="c1")
            )
            self.assertIsNone(
                self.bridge.post_tool_call(tool_name="web_search", args={}, tool_call_id="c1")
            )
            self.tick()

    def test_a_tool_call_outside_a_slick_turn_is_not_ours(self) -> None:
        # Live, but the tool ran on some other surface's own thread — which is
        # exactly what having no context variable means.
        self.bridge.turn_started({"chat_id": "general", "thread_id": "msg_root"})
        self.addCleanup(
            self.bridge.turn_finished, {"chat_id": "general", "thread_id": "msg_root"}
        )
        self.bridge.pre_tool_call(tool_name="web_search", args={}, tool_call_id="c1")
        self.tick()
        self.assertEqual(self.thinkings(), [])

    def test_reasoning_never_lands_in_the_draft(self) -> None:
        with self.turn():
            self.bridge.on_stream_delta(surface="slick", delta="weighing it up", kind="reasoning")
            self.tick()
            think = self.thinkings()[-1]["think"]
        self.assertEqual(self.deltas(), [], "reasoning is not the answer being drafted")
        self.assertEqual([step["id"] for step in think["s"]], [adapter.REASONING_STEP_ID])
        self.assertEqual(think["s"][0]["o"], "weighing it up")

    def test_a_delta_with_no_context_finds_the_one_live_turn(self) -> None:
        """The observer's dispatcher thread predates the turn by minutes."""
        target = {"chat_id": "general", "thread_id": "msg_root"}
        self.bridge.turn_started(target)
        self.addCleanup(self.bridge.turn_finished, target)
        self.bridge.on_stream_delta(surface="slick", delta="hello", kind="text")
        self.tick()
        self.assertEqual([body["threadId"] for body in self.deltas()], ["msg_root"])

    def test_two_live_turns_are_not_guessed_between(self) -> None:
        first = {"chat_id": "general", "thread_id": "msg_a"}
        second = {"chat_id": "general", "thread_id": "msg_b"}
        self.bridge.turn_started(first)
        self.bridge.turn_started(second)
        self.addCleanup(self.bridge.turn_finished, second)
        self.addCleanup(self.bridge.turn_finished, first)
        self.bridge.on_stream_delta(surface="slick", delta="hello", kind="text")
        self.tick()
        self.assertEqual(self.deltas(), [], "a draft in the wrong thread is worse than none")

    def test_a_model_call_ending_is_not_the_turn_ending(self) -> None:
        with self.turn():
            self.bridge.on_stream_start(surface="slick")
            self.bridge.on_stream_end(surface="slick", final_text="one", finished=True, error=None)
            self.tick()
            phases = [body["think"]["p"] for body in self.thinkings()]
            self.assertEqual(set(phases), {"streaming"}, "a tool loop runs several streams")

    def test_the_turn_ending_settles_the_box(self) -> None:
        with self.turn():
            self.bridge.on_stream_start(surface="slick")
            self.bridge.pre_tool_call(tool_name="web_search", args={}, tool_call_id="c1")
        self.tick()
        think = self.thinkings()[-1]["think"]
        self.assertEqual(think["p"], "done")
        self.assertEqual([step["st"] for step in think["s"]], ["complete"])
        self.assertTrue(self.deltas()[-1]["done"], "the draft is over too")

    async def test_a_turn_that_raised_leaves_the_box_saying_where_it_stopped(self) -> None:
        """The one case the box is worth opening for.

        A turn that fell over stopped inside whatever step was running, and
        "complete" over that step is the transcript telling the reader the
        opposite of what happened.
        """
        async def explode(event: Any) -> None:
            # Raised from inside the turn, so the tool step is open when it goes.
            self.bridge.pre_tool_call(tool_name="web_search", args={}, tool_call_id="c1")
            raise RuntimeError("the model fell over")

        self.slick.handle_message = explode  # type: ignore[assignment]
        await self.slick._handle_stream_event(
            {"event": "message", "id": "1", "data": "", "json": message_event(message_id="msg_root")}
        )
        self.tick()
        think = self.thinkings()[-1]["think"]
        self.assertEqual(think["p"], "error")
        self.assertEqual([step["st"] for step in think["s"]], ["error"])

    def test_reasoning_tokens_do_not_each_buy_a_durable_row(self) -> None:
        """The two clocks, from the outside.

        ``/api/thinking`` is written down and never pruned, so it is spent on
        the step opening and on the step settling — not on the tokens in
        between, however many of them there are.
        """
        with self.turn():
            for word in ("weigh", "ing ", "it up"):
                self.bridge.on_stream_delta(surface="slick", delta=word, kind="reasoning")
                self.tick()
            self.assertEqual(len(self.thinkings()), 1, "the step opened, once")
            self.bridge.on_stream_end(surface="slick", final_text="", finished=True, error=None)
            self.tick()
        sent = self.thinkings()
        self.assertEqual(len(sent), 2, "and closed, once")
        self.assertEqual(sent[-1]["think"]["s"][0]["st"], "complete")
        self.assertEqual(
            sent[-1]["think"]["s"][0]["o"],
            "weighing it up",
            "everything reasoned rides out on the transition that closes it",
        )

    async def test_a_turn_with_no_streaming_producer_costs_no_requests(self) -> None:
        """Graceful degradation, from the inbound event down.

        Nothing fires the observer hooks in this suite, so a whole turn must
        reach exactly the routes it reached before any of this existed.
        """
        async def handle(event: Any) -> None:
            await self.slick.send_typing(event.source.chat_id)

        self.slick.handle_message = handle  # type: ignore[assignment]
        await self.slick._handle_stream_event(
            {"event": "message", "id": "1", "data": "", "json": message_event(message_id="msg_root")}
        )
        self.tick()
        self.assertEqual(self.thinkings(), [])
        self.assertEqual(self.deltas(), [])
        self.assertEqual(len(self.server.find("POST", "/api/typing")), 1)

    def test_a_workspace_without_the_routes_is_asked_once(self) -> None:
        self.server.post_status = 404
        self.server.post_error = {"error": {"code": "no_such_route", "message": "gone"}}
        for _ in range(3):
            with self.turn():
                self.bridge.on_stream_delta(surface="slick", delta="hello", kind="text")
                self.bridge.pre_tool_call(tool_name="web_search", args={}, tool_call_id="c1")
            self.tick()
        self.assertEqual(len(self.server.find("POST", "/api/stream/delta")), 1)
        self.assertEqual(len(self.server.find("POST", "/api/thinking")), 1)

    def test_a_daemon_that_refuses_does_not_reach_the_turn(self) -> None:
        self.server.post_status = 500
        with self.turn():
            self.bridge.on_stream_delta(surface="slick", delta="hello", kind="text")
            self.tick()
        self.assertEqual(len(self.server.find("POST", "/api/stream/delta")), 1)

    async def test_a_detached_workspace_is_no_longer_talked_to(self) -> None:
        self.assertTrue(await self.slick.connect())
        await self.slick.disconnect()
        before = len(self.server.requests)
        self.bridge.turn_started({"chat_id": "general", "thread_id": "msg_root"})
        self.bridge.on_stream_delta(surface="slick", delta="hello", kind="text")
        self.bridge.turn_finished({"chat_id": "general", "thread_id": "msg_root"})
        self.tick()
        # It falls back to the published daemon, which the sandbox has none of,
        # so the point is only that this server is not it any more.
        self.assertEqual(
            [entry for entry in self.server.requests[before:] if "/api/stream" in entry["path"]],
            [],
        )
        self.bridge.attach(self.slick)


class TestStandaloneSender(EnvSandbox, unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.server = FakeSlick()
        self.addCleanup(self.server.close)
        self.config = make_config(self.server.url)

    async def test_delivers_to_the_channel(self) -> None:
        result = await adapter._standalone_send(self.config, "general", "cron says hi")
        self.assertEqual(result, {"success": True, "message_id": "msg_posted"})
        posts = self.server.find("POST", "/api/channels/general/messages")
        self.assertEqual(posts[0]["body"]["text"], "cron says hi")
        self.assertEqual(posts[0]["body"]["metadata"], {"_via": "hermes-cron"})
        self.assertEqual(posts[0]["body"]["author"]["kind"], "agent")
        self.assertEqual(posts[0]["headers"].get("authorization"), "Bearer " + TOKEN)

    async def test_delivers_into_a_thread(self) -> None:
        result = await adapter._standalone_send(
            self.config, "general", "threaded", thread_id="msg_root"
        )
        self.assertTrue(result.get("success"))
        self.assertTrue(self.server.find("POST", "/api/messages/msg_root/replies"))

    async def test_falls_back_to_the_home_channel(self) -> None:
        config = make_config(self.server.url, channel="general", home_channel="reports")
        await adapter._standalone_send(config, "", "no chat id")
        self.assertTrue(self.server.find("POST", "/api/channels/reports/messages"))

    async def test_reports_errors_without_raising(self) -> None:
        self.server.post_status = 500
        result = await adapter._standalone_send(self.config, "general", "hi")
        self.assertIn("error", result)
        self.assertNotIn("success", result)
        self.assertNotIn(TOKEN, result["error"])

    async def test_requires_a_token(self) -> None:
        config = PlatformConfig(extra={"url": self.server.url, "channel": "general"})
        result = await adapter._standalone_send(config, "general", "hi")
        self.assertIn("SLICK_TOKEN", result.get("error", ""))
        self.assertEqual(self.server.requests, [])

    async def test_media_files_are_skipped_not_fatal(self) -> None:
        result = await adapter._standalone_send(
            self.config, "general", "with a file", media_files=["/tmp/x.png"]
        )
        self.assertTrue(result.get("success"))


# ---------------------------------------------------------------------------
# Contract: the stubs above must match the Hermes source they stand in for
# ---------------------------------------------------------------------------

def _parse(relative: str):
    path = HERMES_ROOT / relative
    if not path.is_file():
        return None
    try:
        return ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError:  # pragma: no cover - a newer Hermes on an older python
        return None


def _class_node(tree, name: str):
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == name:
            return node
    return None


def _annotated_fields(tree, class_name: str):
    node = _class_node(tree, class_name)
    if node is None:
        return None
    return {
        item.target.id
        for item in node.body
        if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name)
    }


def _params(tree, class_name: Optional[str], func_name: str):
    scope = _class_node(tree, class_name) if class_name else tree
    if scope is None:
        return None
    for node in ast.walk(scope):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            args = node.args
            return {a.arg for a in list(args.args) + list(args.kwonlyargs)}
    return None


def _assigned_set(tree, name: str):
    """The literal ``set`` a module-level name is bound to, or None."""
    for node in ast.walk(tree):
        targets = [node.target] if isinstance(node, ast.AnnAssign) else getattr(node, "targets", [])
        if not any(isinstance(t, ast.Name) and t.id == name for t in targets):
            continue
        value = getattr(node, "value", None)
        if isinstance(value, ast.Set):
            return {
                item.value for item in value.elts
                if isinstance(item, ast.Constant) and isinstance(item.value, str)
            }
    return None


def _hook_call(source: str, hook_name: str, span: int = 900) -> str:
    """The keyword arguments an ``invoke_hook`` call site passes, as text."""
    index = source.find('"{}",'.format(hook_name))
    return source[index:index + span] if index >= 0 else ""


class TestHermesContract(unittest.TestCase):
    """Reads the installed Hermes source; skips when there is none to read."""

    def setUp(self) -> None:
        super().setUp()
        if not HERMES_ROOT.is_dir():
            self.skipTest("no Hermes checkout at {}".format(HERMES_ROOT))

    def _tree(self, relative: str):
        tree = _parse(relative)
        if tree is None:
            self.skipTest("cannot read {}".format(HERMES_ROOT / relative))
        return tree

    def test_register_platform_accepts_every_kwarg_we_pass(self) -> None:
        tree = self._tree("gateway/platform_registry.py")
        fields = _annotated_fields(tree, "PlatformEntry") or set()
        self.assertIn("standalone_sender_fn", fields, "unexpected PlatformEntry shape")
        explicit = _params(self._tree("hermes_cli/plugins.py"), "PluginContext", "register_platform") or set()
        accepted = fields | explicit
        ctx = FakeCtx()
        adapter.register(ctx)
        unknown = set(ctx.platform_kwargs or {}) - accepted
        self.assertEqual(unknown, set(), "register_platform would reject these kwargs")

    def test_message_event_accepts_every_field_we_set(self) -> None:
        fields = _annotated_fields(self._tree("gateway/platforms/base.py"), "MessageEvent")
        self.assertIsNotNone(fields)
        assert fields is not None
        used = {
            "text",
            "message_type",
            "user_id",
            "user_name",
            "source",
            "raw_message",
            "message_id",
            "metadata",
            "timestamp",
        }
        self.assertEqual(used - fields, set())
        self.assertEqual(used - set(MessageEvent.__dataclass_fields__), set(), "stub drifted")

    def test_send_result_accepts_every_field_we_set(self) -> None:
        fields = _annotated_fields(self._tree("gateway/platforms/base.py"), "SendResult")
        self.assertIsNotNone(fields)
        assert fields is not None
        used = {"success", "message_id", "error", "raw_response", "retryable", "error_kind"}
        self.assertEqual(used - fields, set())
        self.assertEqual(used - set(SendResult.__dataclass_fields__), set(), "stub drifted")

    def test_build_source_accepts_every_argument_we_pass(self) -> None:
        params = _params(self._tree("gateway/platforms/base.py"), "BasePlatformAdapter", "build_source")
        self.assertIsNotNone(params)
        assert params is not None
        used = {"chat_id", "chat_name", "chat_type", "user_id", "user_name", "thread_id", "message_id"}
        self.assertEqual(used - params, set())
        stub = _params(ast.parse(Path(__file__).read_text()), "BasePlatformAdapter", "build_source") or set()
        self.assertEqual(used - stub, set(), "stub drifted")

    def test_base_adapter_still_exposes_what_we_override(self) -> None:
        node = _class_node(self._tree("gateway/platforms/base.py"), "BasePlatformAdapter")
        self.assertIsNotNone(node)
        assert node is not None
        names = {
            item.name
            for item in node.body
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        for name in (
            "connect",
            "disconnect",
            "send",
            "get_chat_info",
            "handle_message",
            "build_source",
            "_mark_connected",
            "_mark_disconnected",
            "_set_fatal_error",
            "is_connected",
        ):
            self.assertIn(name, names)

    def test_set_fatal_error_accepts_every_argument_we_pass(self) -> None:
        params = _params(self._tree("gateway/platforms/base.py"), "BasePlatformAdapter", "_set_fatal_error")
        self.assertIsNotNone(params)
        assert params is not None
        used = {"code", "message", "retryable"}
        self.assertEqual(used - params, set())
        stub = _params(ast.parse(Path(__file__).read_text()), "BasePlatformAdapter", "_set_fatal_error") or set()
        self.assertEqual(used - stub, set(), "stub drifted")

    def test_the_gateway_still_fires_agent_end_with_a_model(self) -> None:
        """The stamp's whole supply chain: the event, its keys, and the map."""
        source = (HERMES_ROOT / "gateway" / "run.py").read_text(encoding="utf-8", errors="replace")
        self.assertIn('emit("agent:end"', source, "agent:end is no longer emitted")
        emit = source.split('emit("agent:end"', 1)[1][:400]
        # thread_id joined the list when the badge stopped being chat-keyed.
        for key in ('"model"', '"platform"', '"chat_id"', '"thread_id"'):
            self.assertTrue(
                key in emit or key in source, "agent:end context lost {}".format(key)
            )

    def test_the_hook_registry_still_keeps_a_handler_map(self) -> None:
        """``_handlers`` is private; subscribing through it must be checked."""
        node = _class_node(self._tree("gateway/hooks.py"), "HookRegistry")
        self.assertIsNotNone(node)
        assert node is not None
        init = next(
            (n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == "__init__"),
            None,
        )
        self.assertIsNotNone(init)
        assert init is not None
        assigned = {
            t.attr
            for stmt in ast.walk(init)
            for t in ([stmt.target] if isinstance(stmt, ast.AnnAssign) else getattr(stmt, "targets", []))
            if isinstance(t, ast.Attribute)
        }
        self.assertIn("_handlers", assigned, "HookRegistry no longer keeps _handlers")
        names = {n.name for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
        self.assertIn("emit", names)

    def test_every_hook_we_register_is_still_a_hook_name(self) -> None:
        """An unknown name is only a warning, so it fails silently forever."""
        names = _assigned_set(self._tree("hermes_cli/plugins.py"), "VALID_HOOKS")
        self.assertIsNotNone(names, "VALID_HOOKS is no longer a set literal")
        assert names is not None
        self.assertEqual(
            set(adapter.LIVE_PROGRESS_HOOKS) - names,
            set(),
            "Hermes dropped a hook we register for",
        )

    def test_register_hook_still_takes_a_name_and_a_callback(self) -> None:
        params = _params(self._tree("hermes_cli/plugins.py"), "PluginContext", "register_hook")
        self.assertIsNotNone(params)
        assert params is not None
        self.assertEqual({"hook_name", "callback"} - params, set())

    def test_the_stream_payload_still_names_the_surface_and_the_kind(self) -> None:
        """Every stream callback filters on ``surface``; deltas split on ``kind``."""
        source = (HERMES_ROOT / "run_agent.py").read_text(encoding="utf-8", errors="replace")
        self.assertIn('"surface": self.platform or "cli"', source)
        self.assertIn('enqueue_plugin_stream_hook(\n                "on_stream_delta"', source)
        self.assertIn('kind="text"', source)
        self.assertIn('kind="reasoning"', source)

    def test_reasoning_deltas_are_still_something_the_user_opts_into(self) -> None:
        """Which is why the kind is handled and that config is never written."""
        source = (HERMES_ROOT / "agent" / "plugin_stream_hooks.py").read_text(
            encoding="utf-8", errors="replace"
        )
        self.assertIn("def stream_reasoning_deltas_enabled", source)
        self.assertIn('"plugins", "stream_reasoning_deltas", default=False', source)

    def test_a_stream_callback_still_gets_one_thread_and_a_bounded_queue(self) -> None:
        """The whole reason every callback here buffers and returns.

        One daemon thread per callback draining a queue that drops its oldest
        entry when it fills, and says so only in a debug log — so a callback
        that makes an HTTP request inline loses deltas in silence.
        """
        source = (HERMES_ROOT / "agent" / "plugin_stream_hooks.py").read_text(
            encoding="utf-8", errors="replace"
        )
        self.assertIn("queue.Queue(maxsize=_QUEUE_SIZE)", source)
        self.assertIn("daemon=True", source)
        self.assertIn("plugin stream hook queue full after drop-oldest", source)

    def test_the_tool_hooks_still_carry_what_we_read_and_no_surface(self) -> None:
        """Why ``_tool_thread`` routes on the context variable instead.

        These two are fired inline by the tool path, which does not know which
        platform asked — there is no surface in the payload to filter on.
        """
        tools = (HERMES_ROOT / "model_tools.py").read_text(encoding="utf-8", errors="replace")
        post = _hook_call(tools, "post_tool_call")
        self.assertTrue(post, "post_tool_call is no longer invoked from model_tools")
        for keyword in ("tool_name=", "args=", "tool_call_id=", "status=", "error_message="):
            self.assertIn(keyword, post)
        self.assertNotIn("surface=", post)

        plugins = (HERMES_ROOT / "hermes_cli" / "plugins.py").read_text(
            encoding="utf-8", errors="replace"
        )
        pre = _hook_call(plugins.split("invoke_lifecycle_hook(", 1)[-1], "pre_tool_call")
        self.assertTrue(pre, "pre_tool_call is no longer invoked from plugins")
        for keyword in ("tool_name=", "args=", "tool_call_id=", "turn_id="):
            self.assertIn(keyword, pre)
        self.assertNotIn("surface=", pre)

    def test_an_adapter_without_edit_message_still_refuses_one(self) -> None:
        """The reason gateway streaming stays off — see register()."""
        source = (HERMES_ROOT / "gateway" / "platforms" / "base.py").read_text(
            encoding="utf-8", errors="replace"
        )
        edit = source.split("async def edit_message", 1)
        self.assertEqual(len(edit), 2, "edit_message is gone from the base adapter")
        self.assertIn('return SendResult(success=False, error="Not supported")', edit[1][:2000])

    def test_the_tool_wording_is_still_where_we_import_it_from(self) -> None:
        """Guarded at import, so this is a warning rather than a breakage."""
        names = {
            node.name
            for node in ast.walk(self._tree("agent/display.py"))
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        self.assertEqual({"build_tool_label", "build_status_phrase"} - names, set())

    def test_platform_enum_resolves_registered_plugin_names(self) -> None:
        tree = self._tree("gateway/config.py")
        node = _class_node(tree, "Platform")
        self.assertIsNotNone(node)
        assert node is not None
        names = {
            item.name
            for item in node.body
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        # Platform("slick") only works because _missing_ mints a pseudo-member
        # for a platform the registry knows about.
        self.assertIn("_missing_", names)


class TestPluginPackage(unittest.TestCase):
    """``__init__.py`` must stay import-light: no adapter at module scope.

    Loaded exactly the way ``PluginManager._load_directory_module`` does it,
    so a relative ``from .adapter import ...`` inside ``register()`` resolves.
    """

    PLUGIN_DIR = Path(__file__).resolve().parent

    def _load_package(self, module_name: str):
        spec = importlib.util.spec_from_file_location(
            module_name,
            self.PLUGIN_DIR / "__init__.py",
            submodule_search_locations=[str(self.PLUGIN_DIR)],
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        module.__package__ = module_name
        module.__path__ = [str(self.PLUGIN_DIR)]  # type: ignore[attr-defined]
        sys.modules[module_name] = module
        self.addCleanup(self._unload, module_name)
        spec.loader.exec_module(module)
        return module

    @staticmethod
    def _unload(module_name: str) -> None:
        for name in [
            n for n in sys.modules
            if n == module_name or n.startswith(module_name + ".")
        ]:
            sys.modules.pop(name, None)

    def test_importing_the_package_does_not_import_the_adapter(self) -> None:
        module = self._load_package("hermes_plugins.slick_import_probe")
        self.assertTrue(callable(module.register))
        self.assertNotIn("hermes_plugins.slick_import_probe.adapter", sys.modules)

    def test_register_imports_the_adapter_and_registers_the_platform(self) -> None:
        module = self._load_package("hermes_plugins.slick_register_probe")
        ctx = FakeCtx()
        module.register(ctx)
        self.assertIn("hermes_plugins.slick_register_probe.adapter", sys.modules)
        self.assertEqual((ctx.platform_kwargs or {}).get("name"), "slick")


class TestManifest(unittest.TestCase):
    def test_plugin_yaml_declares_a_platform_plugin(self) -> None:
        text = (Path(__file__).resolve().parent / "plugin.yaml").read_text(encoding="utf-8")
        self.assertIn("kind: platform", text)
        self.assertIn("name: slick-platform", text)
        self.assertIn("SLICK_TOKEN", text)
        self.assertIn("SLICK_CHANNEL", text)

    def test_plugin_yaml_carries_the_version_that_added_live_progress(self) -> None:
        text = (Path(__file__).resolve().parent / "plugin.yaml").read_text(encoding="utf-8")
        self.assertIn("version: 1.1.0", text)


if __name__ == "__main__":
    unittest.main()
