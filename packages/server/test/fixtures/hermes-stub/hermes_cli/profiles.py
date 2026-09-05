"""`hermes_cli.profiles`, reduced to the one question the bridge asks it."""

import os
from pathlib import Path


def get_active_profile_name():
    """Which profile the HERMES_HOME in the environment names."""
    home = Path(os.environ["HERMES_HOME"])
    return home.name if home.parent.name == "profiles" else "default"
