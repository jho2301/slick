"""Slick platform plugin for Hermes Agent.

Deliberately import-light: importing this package must not pull in
``adapter`` (and through it ``gateway.platforms.base`` / ``gateway.config``).
The plugin loader imports ``__init__.py`` via ``spec_from_file_location`` with
``submodule_search_locations`` set to the plugin directory, so the sibling
``adapter`` module resolves as a relative import — done inside
:func:`register`, the entry point Hermes calls once it has decided to load the
plugin.
"""

from __future__ import annotations

__all__ = ["register"]


def register(ctx) -> None:
    """Plugin entry point: called by the Hermes plugin system.

    The adapter is imported here rather than at module scope so that merely
    importing the package stays cheap and free of Hermes gateway internals.
    """
    from .adapter import register as _register

    _register(ctx)
