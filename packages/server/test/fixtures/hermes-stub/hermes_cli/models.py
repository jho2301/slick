"""`hermes_cli.models`, reduced to the catalog calls the bridge may make.

The shapes mirror the real ones, including the awkward part:
`list_available_providers()` walks `CANONICAL_PROVIDERS + ["custom"]` and
**never** looks at `providers:` — a named custom endpoint is not in its answer.
The only place those ids exist is `_configured_custom_provider_ids()`, so a
bridge that used the first list alone would silently drop every configured
endpoint, which is what this fixture is shaped to catch.

`authenticated` is read out of the environment here, the same way the real one
reads env vars and `auth.json`. That is what lets a test see *whose*
credentials the bridge is running with.

`cached_provider_model_ids` returns a plain list that is never `None`. One
canonical provider has no models and one has no credentials — the two cases
the panel has to survive.
"""

import os

_MODELS = {
    "openai-codex": ["gpt-6-astra", "gpt-5.6-luna"],
    "anthropic": ["claude-sonnet-5", "claude-opus-5"],
    "custom:fano": ["local-qwen"],
}


def list_available_providers():
    # A test hook, and the only thing here that is not modelled on Hermes: a
    # real catalog fails with whatever the underlying call raised, and that
    # text routinely names a file on this machine. This lets a test hand the
    # bridge exactly the sentence it must not forward verbatim.
    staged = os.environ.get("SLICK_TEST_CATALOG_FAIL")
    if staged:
        raise RuntimeError(staged)

    key = os.environ.get("STUB_PROVIDER_API_KEY", "")
    return [
        {"id": "openai-codex", "label": "OpenAI Codex", "aliases": ["codex"], "authenticated": True},
        {"id": "anthropic", "label": "Anthropic", "aliases": [], "authenticated": bool(key)},
        {"id": "empty-one", "label": "Empty One", "aliases": [], "authenticated": True},
        {"id": "logged-out", "label": "Logged Out", "aliases": [], "authenticated": False},
        # Always last, always bare, always also in _configured_custom_provider_ids().
        {"id": "custom", "label": "Custom", "aliases": [], "authenticated": True},
    ]


def _configured_custom_provider_ids():
    """Routable custom-provider ids, copied from `hermes_cli/models.py`."""
    ids = {"custom"}
    from hermes_cli.config import load_config
    from hermes_cli.providers import custom_provider_slug

    config = load_config()
    providers = config.get("providers", {})
    if isinstance(providers, dict):
        for key, entry in providers.items():
            if isinstance(entry, dict):
                ids.add(custom_provider_slug(str(entry.get("name") or key), str(key)))
    legacy = config.get("custom_providers", [])
    if isinstance(legacy, list):
        for entry in legacy:
            if isinstance(entry, dict):
                ids.add(custom_provider_slug(str(entry.get("name") or "")))
    return ids


def cached_provider_model_ids(provider, force_refresh=False, **_kwargs):
    return list(_MODELS.get(provider, []))
