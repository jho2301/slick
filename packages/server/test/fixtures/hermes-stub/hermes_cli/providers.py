"""`hermes_cli.providers`, reduced to the one helper the bridge may call."""


def custom_provider_slug(display_name, provider_key=""):
    """Copied from `hermes_cli/providers.py`.

    A keyed `providers:` entry keeps its config key as the durable identity;
    a legacy `custom_providers:` entry has no key, so its normalised display
    name is the identity. Already-prefixed slugs pass through unchanged, which
    is what makes the helper safe to apply twice.
    """
    identity = str(provider_key or "").strip() or str(display_name or "").strip()
    normalized = identity.lower().replace(" ", "-")
    return normalized if normalized.startswith("custom:") else "custom:{}".format(normalized)
