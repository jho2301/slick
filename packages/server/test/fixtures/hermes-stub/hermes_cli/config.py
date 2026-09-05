"""`hermes_cli.config`, reduced to the names the bridge may call."""

import json
import os
import time
from pathlib import Path


def get_config_path():
    """`HERMES_HOME/config.yaml` in the real thing; a sibling here."""
    return Path(os.environ["HERMES_HOME"]) / "config.json"


def get_env_path():
    """`HERMES_HOME/.env` — one profile's own credentials file."""
    return Path(os.environ["HERMES_HOME"]) / ".env"


def load_config():
    path = get_config_path()
    config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    # A test hook, and the only thing here that is not modelled on Hermes: the
    # real load/save pair has a real gap between the read and the write, and a
    # lost-update race is only observable from Node if that gap is widened.
    # The read happens *before* the sleep, so what is held is the stale copy.
    delay = os.environ.get("SLICK_TEST_LOAD_DELAY_MS")
    if delay:
        time.sleep(int(delay) / 1000.0)
    return config


def save_config(config, **_kwargs):
    path = get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2, sort_keys=True), encoding="utf-8")


def load_env():
    """`HERMES_HOME/.env` parsed into a dict, without touching the process.

    The real one memoises and handles BOMs and CRLF; the shape that matters
    here is that it reads *this* profile's file and returns plain strings.
    """
    path = get_env_path()
    if not path.exists():
        return {}
    parsed = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        parsed[key.strip()] = value.strip().strip('"').strip("'")
    return parsed


def clear_model_endpoint_credentials(
    model_cfg,
    clear_api_key=True,
    clear_api_mode=True,
    clear_base_url=False,
):
    """The sanctioned scrub, copied from `hermes_cli/config.py`.

    (Keyword-only in the real signature; positional here only because this
    fixture must stay importable by a 3.9 interpreter without ceremony. The
    bridge calls it by keyword either way.)
    """
    if not isinstance(model_cfg, dict):
        return model_cfg
    if clear_api_key:
        model_cfg.pop("api_key", None)
        model_cfg.pop("api", None)
    if clear_api_mode:
        model_cfg.pop("api_mode", None)
    if clear_base_url:
        model_cfg.pop("base_url", None)
    return model_cfg
