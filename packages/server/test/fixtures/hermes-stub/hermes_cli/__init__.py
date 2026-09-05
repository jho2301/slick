"""A stand-in for the parts of Hermes the Slick bridge is allowed to touch.

`packages/server/src/integrations/hermes/hermes-bridge.py` may only reach Hermes through its
sanctioned helpers — `load_config`/`save_config` for the config file, the
model registry for the catalog. This package provides exactly those names and
nothing else, so a bridge that tried to parse `config.yaml` itself, or to write
it with a regular expression, would fail against this fixture instead of
quietly working until it met a real file with comments in it.

Persistence here is JSON rather than YAML. The format is Hermes' business; the
bridge's business is to load, edit the two keys it owns, and save — which is
what these stubs let a test observe.
"""
