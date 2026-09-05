#!/usr/bin/env python3
"""Slick's read/write window onto one Hermes profile.

Slick is Node and Hermes is Python, and the thing in the middle — `config.yaml`
— is a file that only Hermes fully understands. It has comments in it, anchors,
`${ENV}` interpolation, credentials, a migration history and half a dozen keys
that mean something only in combination. Editing that from Node would mean
writing a YAML round-tripper and a copy of Hermes' migration rules, and getting
either subtly wrong corrupts the file that holds someone's API keys.

So this script is the whole of the coupling: it runs under an interpreter that
can import Hermes, reaches the config **only** through Hermes' own sanctioned
helpers (`load_config` / `save_config`, the same pair `hermes_cli/auth.py`
uses to record a model choice), and speaks JSON on stdout. It never parses
YAML, never edits text, and knows about exactly three keys — `model.default`,
`model.provider` and `agent.reasoning_effort`.

    hermes-bridge.py read  --dir <profile dir>
    hermes-bridge.py write --dir <profile dir>   # {"provider":…,"model":…,"effort":…} on stdin
    hermes-bridge.py usage --dir <profile dir>

All three print one JSON object and exit 0. A Hermes that cannot be imported, a
config that will not load, a catalog that is empty — all of those are *answers*
(`{"ok": false, "code": …}`), because the caller has a panel to draw either
way and a missing catalog must read as "unavailable", never as "no providers".

`effort` is optional and tri-state, because "leave it alone" and "unset it"
are different requests: absent or `null` never touches `agent.reasoning_effort`,
`""` removes it (back to the provider's own default), and a level sets it.

`usage` is the one verb that goes over the network, and it is the only one that
reads a credential — through `agent.account_usage`, Hermes' own account-limits
module, so the endpoint and the three credential tiers stay Hermes' business.
It reports percentages and reset times and nothing else: no token, no `auth.json`
contents, no account id, no endpoint.

Scope, stated once: this edits the profile's **global default**. It is not a
session setting, it does not reach a running gateway, and nothing here restarts
anything. A gateway already up keeps the model it started with until it is
restarted by hand.

Standard library only, and 3.9-compatible, so the tests can drive it with a
system `python3` that could not import Hermes if it wanted to.
"""

import argparse
import contextlib
import hashlib
import json
import os
import re
import sys
import time

# The two keys this script owns. Everything else in `model:` — `key_env`,
# `api_key`, `base_url`, `context_length` — belongs to whoever put it there and
# is read past, never written and never reported.
MODEL_KEY = "default"
PROVIDER_KEY = "provider"

# The third key, in its own section. `agent.reasoning_effort` is the
# profile-global thinking level — the same setting `/reasoning --global` writes
# — and it is read back through Hermes' own resolver rather than compared to a
# list this file keeps, because the vocabulary is Hermes' to change.
AGENT_SECTION = "agent"
EFFORT_KEY = "reasoning_effort"

# What Hermes' own parser reads as "no thinking at all", and the spelling this
# writes for it. `parse_reasoning_effort` accepts `none`/`false`/`disabled` and
# a YAML boolean; one of those has to be the value a picker round-trips, and a
# word survives a YAML rewrite where a bare `false` may not.
EFFORT_OFF = "none"

# One short word, the same shape `setEffort` in @slick/core accepts. Levels are
# not checked against the catalog: a config already holding a level Hermes has
# retired must still be re-saveable, and an unknown level is Hermes' complaint
# to make, in Hermes' words.
EFFORT_VALUE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")

# What a provider slug or a model id may look like on the way in. Model ids
# carry vendor prefixes and version dots (`anthropic/claude-sonnet-4.5`) and
# custom providers carry a colon (`custom:fano`), so this is broad on purpose —
# it is a check against control characters and newlines reaching a config file,
# not an attempt to know every id Hermes will ever accept.
SAFE_VALUE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._:/@+-]{0,199}$")

# Anything long and unbroken in an error message could be a token that was
# interpolated into a path or a URL. Errors are for the human reading a panel,
# not for reconstructing a credential, so the run is cut out.
_SECRETISH = re.compile(r"[A-Za-z0-9_\-]{24,}")

# Anything rooted at `/`, `~/` or a drive letter. This is the shape an
# exception string takes the moment it names a file — `IsADirectoryError:
# [Errno 21] Is a directory: '/Users/…/.hermes/profiles/work/.env'` — and every
# one of these sentences is on its way to a browser. The layout of the
# daemon's disk is not the browser's business, and a screenshot of a panel is
# how it stops being private.
#
# The lookbehind is what keeps this off the things that merely contain a
# slash. `anthropic/claude-sonnet-4.5` is a model id and `https://box/v1` is an
# endpoint: in both the slash follows a word character or a colon, never a
# space or a quote, so neither can start a match. They are the context that
# makes a failure readable, and redacting them would leave a sentence that
# says only that something went wrong somewhere.
_LOCAL_PATH = re.compile(
    r"(?<![A-Za-z0-9_:~./\\-])"
    r"(?:"
    r"[A-Za-z]:\\[^\s'\"]*"  # C:\Users\…\config.yaml
    r"|~?(?:/[A-Za-z0-9_.~@%+…-]+)+/?"  # /Users/…/.env, ~/.hermes/config.yaml
    r")"
)

# What is worth keeping when a path is cut out: the punctuation that ended the
# sentence it sat in. A segment charclass has to contain `.` to match
# `config.yaml`, so it also swallows the full stop after `python3`.
_TRAILING = ".,;:)"


def _mask_path(match):
    text = match.group(0)
    kept = ""
    while text and text[-1] in _TRAILING:
        kept = text[-1] + kept
        text = text[:-1]
    return "…" + kept


def _scrub(text):
    """A sentence with nothing key-shaped and no place on this machine in it.

    Paths first, and the order is load-bearing: a temp directory has a long
    random segment in it, so a secret pass that ran first would replace that
    segment with `…` and leave the rest of the path unmatched — a censored path
    is still a path. Collapsing the path whole takes the token with it, and the
    secret pass then does its work on what is left. `redactForBrowser` in
    hermes.js composes the same two rules in the same order.
    """
    return _SECRETISH.sub("…", _LOCAL_PATH.sub(_mask_path, str(text)))[:400]


def _safe_error(exc):
    """An exception as a sentence, with anything key-shaped taken out."""
    return _scrub("{}: {}".format(type(exc).__name__, exc))


def _out(payload):
    # The one gate every answer leaves through, so a message assembled by any
    # branch below — including one added later — cannot carry a path out. The
    # scrub is idempotent, so doing it at the source *and* here costs nothing.
    for field in ("error", "catalogError"):
        if isinstance(payload.get(field), str):
            payload[field] = _scrub(payload[field])
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    return 0


def _fail(code, message):
    return _out(
        {
            "ok": False,
            "code": code,
            "error": message,
            "defaults": _empty(),
            "providers": [],
            "effort": None,
            "efforts": [],
            "effectiveEffort": None,
        }
    )


def _empty():
    return {"provider": None, "model": None}


def _import_hermes():
    """Hermes' own config helpers, or a sentence saying why not.

    `HERMES_HOME` is already set to the profile directory by the time this
    runs — that is Hermes' own switch, and `resolve_profile_env()` sets it the
    same way before any import for the same reason: `get_config_path()` reads
    it at call time, so the profile has to be chosen before anything caches it.
    """
    try:
        from hermes_cli.config import load_config, save_config

        return load_config, save_config, None
    except Exception as exc:  # ImportError, but a broken install raises others
        # `sys.executable` is an absolute path, so the whole sentence goes
        # through the scrub rather than only the exception half of it. Which
        # interpreter it was is answerable from the daemon's own logs; the
        # panel only needs to know that this one could not import Hermes.
        return None, None, _scrub(
            "Hermes could not be imported by {}. {}".format(sys.executable, _safe_error(exc))
        )


def _config_path():
    """Where Hermes says this profile's config lives. Never guessed at."""
    from hermes_cli.config import get_config_path

    return str(get_config_path())


def _config_is_contained(path):
    """Is the file about to be read or replaced really the profile's own?

    Node has already refused a profile whose `config.yaml` is a symlink, but
    that check and this open are two moments, and the file is the one thing a
    save replaces. Asking again here costs a `lstat` and closes the window.
    """
    return not os.path.islink(path)


# ------------------------------------------------------- this profile's env ---


def _apply_profile_env():
    """Put this profile's own `.env` into the environment, and nothing else.

    The daemon spawns this with its provider secrets stripped out (see
    `bridgeEnvironment` in hermes.js), which is what stops one login being
    reported as another's — but stripping alone would leave *every* profile
    looking logged out. Hermes keeps one `.env` per profile precisely so the
    answer can come from the profile, so this loads that file, through Hermes'
    own parser, for the profile `HERMES_HOME` names.

    `load_env()` reads and returns; it does not touch the process or rewrite
    the file. Returns a sentence if the file was skipped, else None.
    """
    try:
        from hermes_cli.config import get_env_path, load_env
    except Exception as exc:
        return "This profile's .env could not be read. " + _safe_error(exc)

    try:
        path = str(get_env_path())
    except Exception as exc:
        return "This profile's .env could not be located. " + _safe_error(exc)

    # Same rule as the config file: a `.env` that is a link is one profile
    # borrowing another's credentials, which is the thing being prevented.
    if os.path.islink(path):
        return "This profile's .env is a symlink and was not loaded."
    if not os.path.exists(path):
        return None

    try:
        for key, value in (load_env() or {}).items():
            if isinstance(key, str) and isinstance(value, str) and key:
                os.environ[key] = value
    except Exception as exc:
        return "This profile's .env could not be parsed. " + _safe_error(exc)
    return None


# ------------------------------------------------------------------- reading ---


def _model_section(config):
    """`model:` as a dict, whatever shape it is written in.

    Hermes accepts a bare string (`model: gpt-6-astra`) and upgrades it to
    `{default: …}` on the next `model.*` write. Reading has to understand both
    or a profile written the short way looks unset.
    """
    section = config.get("model")
    if isinstance(section, dict):
        return dict(section)
    if isinstance(section, str) and section.strip():
        return {MODEL_KEY: section.strip()}
    return {}


def _defaults_from(config):
    """The two fields, and only the two fields.

    A whitelist rather than a blacklist: `model:` also holds `api_key`,
    `key_env` and `key_cmd`, and a payload built by removing the keys we happen
    to know are secret would start leaking the day Hermes adds a third one.
    """
    section = _model_section(config)
    model = section.get(MODEL_KEY)
    provider = section.get(PROVIDER_KEY)
    return {
        "provider": provider.strip() if isinstance(provider, str) and provider.strip() else None,
        "model": model.strip() if isinstance(model, str) and model.strip() else None,
    }


# ------------------------------------------------------- how hard it thinks ---

_REASONING = None


def _reasoning():
    """Hermes' own reasoning helpers, asked for once.

    `resolve_reasoning_config` is the chokepoint every Hermes surface resolves
    thinking through — per-model overrides, a globally disabled level, the
    aliases for "off" — and `VALID_REASONING_EFFORTS` is the list a picker may
    offer. Both are imported rather than copied for the same reason the config
    is not parsed here: the vocabulary is Hermes', and a list frozen into this
    file would start lying the first time Hermes added a level.

    Guarded, and cached including the failure: a Hermes too old to have them is
    a profile whose level cannot be offered, not a profile that cannot be read.
    """
    global _REASONING
    if _REASONING is None:
        try:
            from hermes_constants import (
                VALID_REASONING_EFFORTS,
                parse_reasoning_effort,
                resolve_reasoning_config,
            )

            _REASONING = (parse_reasoning_effort, tuple(VALID_REASONING_EFFORTS), resolve_reasoning_config)
        except Exception:
            _REASONING = (None, (), None)
    return _REASONING


def _canonical_effort(raw):
    """One config value as the level a picker shows, or None for "unset".

    Hermes' parser first, so `false`, `off` and `disabled` all arrive as the
    one word this writes for them. What it makes nothing of is passed through
    unchanged rather than dropped: a level the running Hermes has never heard
    of is still what the file says, and a panel that showed "unset" for it
    would overwrite it on the next save on behalf of someone who believed they
    had changed nothing.
    """
    parse, _levels, _resolve = _reasoning()
    if parse is not None:
        try:
            parsed = parse(raw)
        except Exception:
            parsed = None
        if isinstance(parsed, dict):
            if parsed.get("enabled") is False:
                return EFFORT_OFF
            return str(parsed.get("effort") or "").strip() or None
    if raw is False:
        return EFFORT_OFF
    if raw is None or raw is True:
        return None
    return str(raw).strip() or None


def _effort_from(config):
    """The profile-global level: `agent.reasoning_effort`, and nothing else.

    Not the effective one. A per-model override outranks this, and the two are
    different facts — see `_effective_effort`.
    """
    section = config.get(AGENT_SECTION)
    return _canonical_effort(section.get(EFFORT_KEY, "") if isinstance(section, dict) else "")


def _effective_effort(config):
    """What this profile's configured model would actually think at.

    `resolve_reasoning_config` with no model derives it from the config's own
    `model:` section, which is exactly the question the panel is asking: given
    this file as it stands, what happens? An `agent.reasoning_overrides` entry
    for that model wins here and does not in `_effort_from`, which is the whole
    reason both are reported.
    """
    _parse, _levels, resolve = _reasoning()
    if resolve is None:
        return None
    try:
        resolved = resolve(config)
    except Exception:
        return None
    if not isinstance(resolved, dict):
        return None
    if resolved.get("enabled") is False:
        return EFFORT_OFF
    return str(resolved.get("effort") or "").strip() or None


def _agent_section(config):
    """`agent:` as a dict, or an empty one. Never the caller's own object."""
    section = config.get(AGENT_SECTION)
    return dict(section) if isinstance(section, dict) else {}


def _apply_effort(config, effort):
    """Put `agent.reasoning_effort` where the request asked for it.

    Tri-state, and the three cases are three different requests:

      - `None` — the caller said nothing about the level. The key is not read,
        not written and not removed; a save of the provider/model pair must
        leave a level someone set elsewhere exactly as it was.
      - `""` — unset it. The key goes; the section stays if anything else is in
        it, because `agent:` holds `name`, `tools` and everything else this
        script does not own.
      - a level — write it verbatim. Not checked against the catalog: a config
        already holding a level this Hermes has retired must still be
        re-saveable, and an unknown level is Hermes' complaint to make.
    """
    if effort is None:
        return
    section = _agent_section(config)
    if effort == "":
        if EFFORT_KEY not in section:
            return
        section.pop(EFFORT_KEY, None)
        # An `agent:` that held nothing but this key is a section Slick wrote;
        # leaving `agent: {}` behind would be a shape nobody asked for.
        if section:
            config[AGENT_SECTION] = section
        else:
            config.pop(AGENT_SECTION, None)
        return
    section[EFFORT_KEY] = effort
    config[AGENT_SECTION] = section


def _effort_choices():
    """The levels this Hermes accepts, in its own order, with "off" last.

    Hermes' own picker (`_prompt_reasoning_effort_selection`) orders them this
    way, and "off" is not in `VALID_REASONING_EFFORTS` because it is not a
    level — it is the other thing `parse_reasoning_effort` accepts. Empty when
    Hermes could not be asked; the panel then offers only what is configured.
    """
    _parse, levels, _resolve = _reasoning()
    values = []
    for level in levels:
        text = str(level or "").strip()
        if text and text not in values:
            values.append(text)
    if not values:
        return []
    if EFFORT_OFF not in values:
        values.append(EFFORT_OFF)
    return [{"value": value, "label": value} for value in values]


def _custom_provider_ids():
    """The custom endpoints this profile has actually configured.

    `list_available_providers()` does not have them. It walks
    `CANONICAL_PROVIDERS + ["custom"]` and never opens `providers:`, so every
    named endpoint — the whole reason someone configured one — is missing from
    it. The ids such an endpoint is routable by live in
    `_configured_custom_provider_ids()`, which is where `parse_model_input()`
    and the ACP adapter get them from too.

    Underscored, and reached for anyway: it is the only enumeration Hermes
    has, and re-deriving the slugs here from `providers:` would be exactly the
    guess this file exists to avoid. `custom_provider_slug()` is applied on top
    because it is the function that decides the spelling — it is idempotent for
    an already-prefixed id, so this normalises without renaming.
    """
    try:
        from hermes_cli.models import _configured_custom_provider_ids
    except Exception:
        return []
    try:
        configured = _configured_custom_provider_ids() or set()
    except Exception:
        return []

    try:
        from hermes_cli.providers import custom_provider_slug
    except Exception:
        custom_provider_slug = None

    ids = []
    for entry in configured:
        slug = str(entry or "").strip()
        if not slug:
            continue
        if custom_provider_slug is not None and slug != "custom":
            try:
                slug = str(custom_provider_slug(slug, slug)).strip()
            except Exception:
                pass
        if slug:
            ids.append(slug)
    return sorted(ids)


def _catalog():
    """Providers and their models, as Hermes enumerates them.

    Nothing is invented. `list_available_providers()` is Hermes' own canonical
    provider list, `_configured_custom_provider_ids()` is its own list of the
    endpoints this profile configured, and `cached_provider_model_ids()` is its
    own disk-cached model list per provider — so a provider-qualified id keeps
    exactly the spelling Hermes gave it, `custom:` prefix and all.

    The two lists overlap by exactly one entry: both of them contain the bare
    `custom`. They are merged on the id rather than concatenated, because a
    provider offered twice is a picker with two rows that mean one thing.

    A provider whose id starts with `custom:` is flagged rather than renamed:
    the slug *is* the identity, and rewriting it to look tidier would produce a
    value `model.provider` cannot be set to.

    Failure is empty plus a reason. A guessed catalog is worse than none: it
    would offer models that this installation has no credentials for.
    """
    try:
        from hermes_cli.models import cached_provider_model_ids, list_available_providers
    except Exception as exc:
        return [], _safe_error(exc)

    try:
        raw = list_available_providers() or []
    except Exception as exc:
        return [], _safe_error(exc)

    providers = []
    seen = set()

    def offer(slug, label, authenticated):
        if slug.lower() in seen:
            return
        seen.add(slug.lower())
        try:
            models = cached_provider_model_ids(slug) or []
        except Exception:
            # One provider that will not answer is one provider missing its
            # models, not a catalog that failed.
            models = []
        providers.append(
            {
                "value": slug,
                "label": label,
                "custom": slug == "custom" or slug.startswith("custom:"),
                "authenticated": authenticated,
                "models": [
                    {"value": str(m), "label": str(m)}
                    for m in models
                    if isinstance(m, (str, bytes)) and str(m).strip()
                ],
            }
        )

    for entry in raw:
        if not isinstance(entry, dict):
            continue
        slug = str(entry.get("id") or "").strip()
        if not slug:
            continue
        offer(slug, str(entry.get("label") or slug), bool(entry.get("authenticated")))

    for slug in _custom_provider_ids():
        # `authenticated` is null, not false: Hermes has no credential check
        # for a named endpoint, and a `false` would be drawn as "logged out"
        # about a provider that may well be reachable. Unknown is the truth.
        offer(slug, slug.split(":", 1)[-1] or slug, None)

    return providers, None


def _active_profile():
    """Which profile the *running* Hermes is on, for the panel to say so."""
    try:
        from hermes_cli.profiles import get_active_profile_name

        return str(get_active_profile_name() or "") or None
    except Exception:
        return None


def do_read(_args):
    load_config, _save, why = _import_hermes()
    if load_config is None:
        return _fail("hermes_unavailable", why)

    # Before the config and before the catalog. `list_available_providers()`
    # asks `get_auth_status()` and reads provider keys out of `os.environ`, and
    # the environment it was handed has been emptied of everyone else's — so
    # this is the step that makes "is this profile logged in" a question about
    # this profile.
    env_skipped = _apply_profile_env()

    try:
        config_path = _config_path()
    except Exception as exc:
        return _fail("config_unreadable", "Hermes could not say where this profile's config is. " + _safe_error(exc))
    if not _config_is_contained(config_path):
        return _fail("config_unsafe", "This profile's config.yaml is a link to another file; Slick will not read through it.")

    try:
        config = load_config()
    except Exception as exc:
        return _fail("config_unreadable", "Hermes could not read this profile's config. " + _safe_error(exc))

    providers, catalog_error = _catalog()
    return _out(
        {
            "ok": True,
            "code": None,
            "error": None,
            "defaults": _defaults_from(config),
            "effort": _effort_from(config),
            "efforts": _effort_choices(),
            "effectiveEffort": _effective_effort(config),
            "providers": providers,
            # A catalog built without the profile's own environment can only
            # under-report what is logged in, so say so rather than let the
            # panel present it as settled.
            "catalogError": catalog_error or env_skipped,
            "active": _active_profile(),
            # No `home` here, deliberately. Nothing on the Node side ever read
            # it, and an absolute path sitting in the answer is one field
            # someone forwards by accident.
        }
    )


# ----------------------------------------------------------- account limits ---

# The providers `fetch_account_usage` knows how to answer for. Asked for one it
# does not, it returns `None` — indistinguishable from "asked and got nothing"
# — so the question is not put to it at all for the others, and the panel is
# told `supported: false` instead of "unavailable", which is a different fact.
USAGE_PROVIDERS = {"openai-codex"}

# How Hermes phrases banked resets in `AccountUsageSnapshot.details`. Read for
# the count only, and never required: the sentence itself is passed through
# whatever happens, so a Hermes that rewords it loses the badge and keeps the
# line rather than losing both.
BANKED_RESETS = re.compile(r"\byou have (\d{1,6}) reset", re.IGNORECASE)


def _usage_provider(config):
    """The provider whose limits this profile's usage would be about.

    `model.provider`, which is what the profile is configured to run on —
    the same field the panel's provider select edits. Not the process's own
    provider, and not whatever a gateway happens to be up on: this answers
    "what would a new conversation on this profile spend", which is the
    question the rail is asking.
    """
    provider = _defaults_from(config).get("provider")
    return str(provider or "").strip().lower() or None


def _iso(value):
    """A datetime as UTC ISO-8601, or None. Never a local-time string.

    The browser formats it; a naive datetime is assumed UTC because that is
    what `_parse_dt` produces for every Codex `reset_at` it reads.
    """
    if value is None:
        return None
    try:
        from datetime import timezone

        stamped = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return stamped.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def _usage_window(window):
    """One rate-limit window, as numbers a panel can draw a meter from.

    `used_percent` is what the Codex backend reports; `remainingPercent` is
    computed here rather than in the browser so both halves are clamped by the
    same rule — a backend that reports 103% used is 0% remaining, not -3%.
    """
    used = getattr(window, "used_percent", None)
    if isinstance(used, bool) or not isinstance(used, (int, float)):
        used = None
    else:
        used = float(used)
        if used != used or used in (float("inf"), float("-inf")):  # NaN / Inf
            used = None
        else:
            used = max(0.0, min(100.0, used))
    detail = getattr(window, "detail", None)
    return {
        "label": str(getattr(window, "label", "") or "").strip() or "Limit",
        "usedPercent": used,
        "remainingPercent": None if used is None else round(100.0 - used, 4),
        "resetAt": _iso(getattr(window, "reset_at", None)),
        "detail": _scrub(str(detail)) if isinstance(detail, str) and detail.strip() else None,
    }


def _banked_resets(details):
    """The banked reset-credit count, if Hermes said one in so many words."""
    for line in details:
        found = BANKED_RESETS.search(line)
        if found:
            try:
                return int(found.group(1))
            except ValueError:
                return None
    return None


def _usage_payload(snapshot, provider):
    """One `AccountUsageSnapshot`, as JSON with nothing in it but the numbers.

    A whitelist, like `_defaults_from`: the snapshot is a dataclass today and
    the fields taken are the ones the panel draws. Anything Hermes adds later
    — a token, an account id, an endpoint — stays out until someone chooses to
    let it out. Every string still goes through `_scrub`, because `details` is
    free text Hermes composed and this is the last gate before a browser.
    """
    raw_details = [line for line in (getattr(snapshot, "details", None) or ()) if isinstance(line, str) and line.strip()]
    # The count is read from what Hermes actually said, before `_scrub` has
    # been anywhere near it. Every line is then passed through as Hermes wrote
    # it (scrubbed, like every other string leaving here): the structured count
    # is what the panel badges, and the sentence is what it quotes.
    banked = _banked_resets(raw_details)
    details = [_scrub(line) for line in raw_details]
    windows = [_usage_window(window) for window in (getattr(snapshot, "windows", None) or ())]
    reason = getattr(snapshot, "unavailable_reason", None)
    return {
        "provider": str(getattr(snapshot, "provider", "") or provider or "").strip() or provider,
        "supported": True,
        # Hermes' own `available`: windows or details, and nothing saying why not.
        "available": bool((windows or details) and not reason),
        "title": str(getattr(snapshot, "title", "") or "Account limits").strip() or "Account limits",
        "plan": str(getattr(snapshot, "plan", "") or "").strip() or None,
        "source": str(getattr(snapshot, "source", "") or "").strip() or None,
        "fetchedAt": _iso(getattr(snapshot, "fetched_at", None)),
        "windows": windows,
        "details": details,
        "bankedResets": banked,
        "unavailableReason": _scrub(str(reason)) if isinstance(reason, str) and reason.strip() else None,
    }


def _unsupported(provider):
    """A profile whose provider has no account-limits API to ask."""
    return {
        "provider": provider,
        "supported": False,
        "available": False,
        "title": "Account limits",
        "plan": None,
        "source": None,
        "fetchedAt": None,
        "windows": [],
        "details": [],
        "bankedResets": None,
        "unavailableReason": None,
    }


def _classify_usage_error(exc):
    """Why the fetch failed, in a word the panel can branch on and a sentence.

    The distinction that matters is *not authenticated* versus *could not
    ask*: the first is something the human can fix by signing in, the second
    is something to retry. Hermes' own `fetch_account_usage` collapses both to
    `None`, so the exception is caught here instead — which is also what keeps
    the message ours rather than an httpx repr with a URL in it.
    """
    name = type(exc).__name__
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(status, int):
        if status in (401, 403):
            return (
                "not_authenticated",
                "Your ChatGPT account rejected the request (HTTP {}). Sign in again with `hermes auth`.".format(status),
            )
        if status == 429:
            return ("usage_rate_limited", "The usage endpoint is rate-limiting this account. Try again shortly.")
        return ("usage_http_error", "The usage endpoint answered HTTP {}.".format(status))
    if name in ("AuthError", "RuntimeError"):
        # `_resolve_codex_usage_credentials` raises one of these when neither
        # the singleton token store nor the credential pool has anything.
        return (
            "not_authenticated",
            "This profile has no usable ChatGPT credentials. Sign in with `hermes auth`.",
        )
    if name.startswith(("Connect", "Timeout", "ReadTimeout", "Network", "Proxy", "Pool")) or "Timeout" in name:
        return ("usage_unreachable", "The usage endpoint could not be reached.")
    # Deliberately the exception's *type*, not its text: an httpx message can
    # carry a URL, and a refresh failure can carry whatever the provider said.
    return ("usage_failed", "Hermes could not read this account's limits ({}).".format(name))


def _fetch_usage(provider):
    """Hermes' own Codex usage fetch, with the reason kept when it fails.

    `agent.account_usage` is imported rather than reimplemented: the endpoint,
    the PathStyle split, the three credential tiers and the `ChatGPT-Account-Id`
    header are Hermes' business and change with the Codex backend. What is done
    differently is only the error handling — `fetch_account_usage` swallows
    every exception and returns `None`, and a panel that says "unavailable" for
    a revoked login is a panel that sends someone looking for a network fault.

    So the provider-specific fetch is called directly where it exists, and the
    sanctioned entry point is the fallback for a Hermes that has moved it.
    """
    try:
        from agent import account_usage
    except Exception as exc:
        return None, "usage_unsupported", "This Hermes has no account-limits support. " + _safe_error(exc)

    direct = getattr(account_usage, "_fetch_codex_account_usage", None) if provider == "openai-codex" else None
    if direct is not None:
        try:
            return direct(), None, None
        except Exception as exc:
            code, message = _classify_usage_error(exc)
            return None, code, message

    fetch = getattr(account_usage, "fetch_account_usage", None)
    if fetch is None:
        return None, "usage_unsupported", "This Hermes has no `fetch_account_usage`."
    try:
        return fetch(provider), None, None
    except Exception as exc:
        code, message = _classify_usage_error(exc)
        return None, code, message


def _usage_fail(code, message, provider, supported=True):
    """A usage answer that failed, still carrying which provider it was about."""
    payload = _unsupported(provider)
    payload["supported"] = supported
    return _out({"ok": False, "code": code, "error": message, "usage": payload})


def do_usage(_args):
    load_config, _save, why = _import_hermes()
    if load_config is None:
        return _usage_fail("hermes_unavailable", why, None, supported=False)

    # Before the config and before the fetch, exactly as `do_read` does it:
    # the credentials this asks about have to be *this* profile's, and the
    # daemon handed over an environment with everyone else's stripped out.
    env_skipped = _apply_profile_env()

    try:
        config_path = _config_path()
    except Exception as exc:
        return _usage_fail(
            "config_unreadable",
            "Hermes could not say where this profile's config is. " + _safe_error(exc),
            None,
            supported=False,
        )
    if not _config_is_contained(config_path):
        return _usage_fail(
            "config_unsafe",
            "This profile's config.yaml is a link to another file; Slick will not read through it.",
            None,
            supported=False,
        )

    try:
        config = load_config()
    except Exception as exc:
        return _usage_fail(
            "config_unreadable",
            "Hermes could not read this profile's config. " + _safe_error(exc),
            None,
            supported=False,
        )

    provider = _usage_provider(config)
    if provider not in USAGE_PROVIDERS:
        # Not an error. A profile on Anthropic has no Codex limits to show, and
        # saying "unavailable" would read as a failure to fetch them.
        return _out({"ok": True, "code": None, "error": None, "usage": _unsupported(provider)})

    snapshot, code, message = _fetch_usage(provider)
    if code:
        return _usage_fail(code, message, provider)
    if snapshot is None:
        return _usage_fail(
            "usage_unavailable",
            "Hermes had nothing to report for this account.",
            provider,
        )

    payload = _usage_payload(snapshot, provider)
    return _out(
        {
            "ok": True,
            "code": None,
            "error": None,
            "usage": payload,
            # A profile whose `.env` was skipped may be answering on the wrong
            # credentials, and that is worth saying next to a number.
            "catalogError": env_skipped,
        }
    )


# ------------------------------------------------------------------- writing ---


def _clean(value, what):
    text = "" if value is None else str(value).strip()
    if not text:
        raise ValueError("A {} is required.".format(what))
    if not SAFE_VALUE.match(text):
        raise ValueError("{!r} is not a usable {}.".format(text[:60], what))
    return text


def _clean_effort(value):
    """The level a write asked for: None to leave it, "" to unset, or a level.

    An absent key and a `null` are the same request — "this write is not about
    the thinking level" — which is what lets the model picker save without
    having an opinion on it. Anything else has to survive `EFFORT_VALUE`
    *before* it is anywhere near a config file: a level is one short word, and
    a string with a newline in it is someone trying to write a second key.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("{!r} is not a thinking level.".format(value))
    text = value.strip()
    if not text:
        return ""
    if not EFFORT_VALUE.match(text):
        raise ValueError("{!r} is not a thinking level.".format(text[:60]))
    return text


def _is_provider_switch(previous, provider):
    """Is this a move to a different provider, or another model on the same one?

    Compared the way `hermes_cli/web_server.py` compares them — trimmed and
    case-folded — because that is the comparison whose answer decides whether
    the endpoint fields below belong to the provider being left.
    """
    return str(previous or "").strip().lower() != str(provider or "").strip().lower()


def _clear_endpoint_credentials(section):
    """Drop what belonged to the endpoint this profile is switching away from.

    `model.api_key` (and its legacy `model.api` alias, and `model.api_mode`)
    are only meaningful for an explicit custom endpoint; a built-in provider
    resolves its credentials from `auth.json`, the environment, or the
    credential pool. Leaving them behind keeps a secret in `config.yaml` for a
    provider that will never present it, and contaminates the next custom
    resolution — which is the reasoning in
    `hermes_cli.config.clear_model_endpoint_credentials`, so that is what does
    the scrubbing.

    `base_url` goes too. The helper deliberately leaves it — its callers decide
    — and every one of them that switches provider without being handed a new
    URL drops it (`_persist_active_provider` in `auth.py`, the MoA flow in
    `model_setup_flows.py`, the assignment path in `web_server.py`). Slick has
    no endpoint field to hand over one, so a URL that survived here would point
    the new provider at the old one's host.

    Deliberately *not* touched: `key_env`, `key_cmd`, `context_length` and
    anything else in `model:`. They are not endpoint credentials, and this
    edit is a model choice, not a reset.
    """
    try:
        from hermes_cli.config import clear_model_endpoint_credentials

        clear_model_endpoint_credentials(section)
    except Exception:
        # A Hermes too old to have the helper still must not keep the secret.
        # This is its body, not a broader guess: api_key, its alias, api_mode.
        for key in ("api_key", "api", "api_mode"):
            section.pop(key, None)
    section.pop("base_url", None)


# The two processes' worth of gap this closes are real: the bridge is spawned
# per request, so two saves of one profile are two interpreters, and an
# in-process lock like Hermes' own `_CONFIG_LOCK` cannot see across them.
_LOCK_WAIT_SECONDS = 15.0


def _fingerprint(path):
    """Exactly what is in the config file at this moment.

    Content, not `st_mtime` and size: two writes inside one filesystem clock
    tick that happen to produce the same length are precisely the case a
    lost-update check exists for.
    """
    try:
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except FileNotFoundError:
        return "absent"


class _Contended(Exception):
    """Another process is mid-write on this profile and would not let go."""


@contextlib.contextmanager
def _profile_config_lock(config_path):
    """Serialise one profile's read/modify/write against other bridge runs.

    `flock` on a sidecar file next to the config, which is the ordinary POSIX
    answer and works on the APFS and network filesystems a `HERMES_HOME` sits
    on. The lock file is opened `O_NOFOLLOW`, so a symlink planted in the
    profile directory cannot redirect the open, and `O_CREAT` without
    truncation, so two racers share one inode. It is never unlinked: removing a
    lock file is itself a race, and an empty 0600 sidecar costs nothing.

    A platform without `fcntl` still gets the conflict check below — it just
    reports a contended save as a conflict rather than waiting for its turn.
    """
    try:
        import fcntl
    except ImportError:
        yield
        return

    flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    try:
        handle = os.open(config_path + ".slick.lock", flags, 0o600)
    except OSError:
        yield  # cannot lock here; the fingerprint check is still in force
        return

    try:
        deadline = time.time() + _LOCK_WAIT_SECONDS
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.time() >= deadline:
                    raise _Contended(
                        "Another process has been saving this profile for {:.0f}s.".format(_LOCK_WAIT_SECONDS)
                    )
                time.sleep(0.02)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
    finally:
        os.close(handle)


def _save_model_choice(load_config, save_config, config_path, provider, model, effort=None):
    """The read/modify/write itself, with the lock already held."""
    # Taken before the read, compared after the edit. Hermes' own writers hold
    # no lock this one can wait on, so the gap is closed by refusing rather
    # than by assuming: whatever went in between is a change someone made, and
    # this is a whole-document write that would erase all of it.
    before = _fingerprint(config_path)

    try:
        config = load_config()
    except Exception as exc:
        return _fail("config_unreadable", "Hermes could not read this profile's config. " + _safe_error(exc))

    # The `_save_model_choice` shape from `hermes_cli/auth.py`, with the
    # provider set in the same pass: start from whatever `model:` already holds
    # so that `key_env` and `context_length` survive, upgrade the bare-string
    # form on the way, and change only the two keys this owns — plus, on a
    # provider switch, drop what belonged to the provider being left.
    section = _model_section(config)
    switching = _is_provider_switch(section.get(PROVIDER_KEY), provider)
    section[MODEL_KEY] = model
    section[PROVIDER_KEY] = provider
    if switching:
        _clear_endpoint_credentials(section)
    config["model"] = section
    # The third key, in the same document and therefore the same save. A level
    # written in its own pass would be a second whole-document write racing the
    # first, which is exactly what the lock above exists to prevent.
    _apply_effort(config, effort)

    if _fingerprint(config_path) != before:
        try:
            reloaded = load_config()
            now = _defaults_from(reloaded)
            now_effort = _effort_from(reloaded)
        except Exception:
            now = _empty()
            now_effort = None
        return _out(
            {
                "ok": False,
                "code": "config_conflict",
                "error": (
                    "This profile's config changed on disk while Slick was preparing the edit, "
                    "so nothing was written. Reload and try again."
                ),
                "defaults": now,
                "effort": now_effort,
                "efforts": _effort_choices(),
                "effectiveEffort": None,
                "providers": [],
            }
        )

    try:
        save_config(config)
    except Exception as exc:
        return _fail("config_unwritable", "Hermes refused to save this profile's config. " + _safe_error(exc))

    # Read it back rather than echoing the request. A save that was silently
    # rejected — a managed key, a policy, a disk that filled — would otherwise
    # be reported as a success, and the panel would show a setting that is not
    # there. What comes back is what the next Hermes to start will read.
    try:
        saved = load_config()
    except Exception as exc:
        return _fail("config_unreadable", "Saved, but the readback failed. " + _safe_error(exc))

    after = _defaults_from(saved)
    # The level as the file now reads, on every branch below. A panel that got
    # a green tick and no level would have nothing to put its select back to.
    levels = {
        "effort": _effort_from(saved),
        "efforts": _effort_choices(),
        "effectiveEffort": _effective_effort(saved),
    }

    if after.get("model") != model or after.get("provider") != provider:
        return _out(
            {
                "ok": False,
                "code": "not_persisted",
                "error": "Hermes did not keep that setting — the config now reads {} on {}.".format(
                    after.get("model") or "no model", after.get("provider") or "no provider"
                ),
                "defaults": after,
                "providers": [],
                **levels,
            }
        )

    # The same check for the third key, and for the same reason: a level a
    # policy or a managed file silently dropped must not come back as a tick.
    if effort is not None and (levels["effort"] or "") != effort:
        return _out(
            {
                "ok": False,
                "code": "not_persisted",
                "error": "Hermes did not keep that thinking level — the config now reads {}.".format(
                    levels["effort"] or "no level"
                ),
                "defaults": after,
                "providers": [],
                **levels,
            }
        )

    return _out({"ok": True, "code": None, "error": None, "defaults": after, "providers": [], **levels})


def do_write(_args):
    load_config, save_config, why = _import_hermes()
    if load_config is None:
        return _fail("hermes_unavailable", why)

    try:
        wanted = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        return _fail("bad_request", _safe_error(exc))
    if not isinstance(wanted, dict):
        return _fail("bad_request", "Expected a JSON object on stdin.")

    try:
        provider = _clean(wanted.get("provider"), "provider")
        model = _clean(wanted.get("model"), "model")
        effort = _clean_effort(wanted.get("effort"))
    except ValueError as exc:
        return _fail("bad_request", str(exc))

    # Before the load, not for the credentials — a save needs none — but
    # because `load_config()` expands `${VAR}` against the environment and
    # `save_config()` restores the template only for values that came back
    # unchanged. Resolving them against this profile's own `.env` is what makes
    # that round-trip land on the same string Hermes itself would have read.
    _apply_profile_env()

    try:
        config_path = _config_path()
    except Exception as exc:
        return _fail("config_unreadable", "Hermes could not say where this profile's config is. " + _safe_error(exc))
    if not _config_is_contained(config_path):
        return _fail(
            "config_unsafe",
            "This profile's config.yaml is a link to another file; Slick will not write through it.",
        )

    try:
        with _profile_config_lock(config_path):
            return _save_model_choice(load_config, save_config, config_path, provider, model, effort)
    except _Contended as exc:
        return _fail("config_locked", str(exc))


# --------------------------------------------------------------------- entry ---


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="verb", required=True)
    for verb in ("read", "write", "usage"):
        one = sub.add_parser(verb)
        one.add_argument("--dir", required=True, help="the profile's HERMES_HOME")

    args = parser.parse_args(argv)

    # Before any Hermes import, because `get_hermes_home()` reads the
    # environment and everything downstream of it caches the answer.
    directory = os.path.abspath(args.dir)
    if not os.path.isdir(directory):
        return _fail("no_such_profile", "There is no directory at that profile path.")
    os.environ["HERMES_HOME"] = directory

    verbs = {"read": do_read, "write": do_write, "usage": do_usage}
    try:
        return verbs[args.verb](args)
    except Exception as exc:  # never a traceback on stdout: the caller reads JSON
        if args.verb == "usage":
            return _usage_fail("bridge_failed", _safe_error(exc), None, supported=False)
        return _fail("bridge_failed", _safe_error(exc))


if __name__ == "__main__":
    sys.exit(main() or 0)
