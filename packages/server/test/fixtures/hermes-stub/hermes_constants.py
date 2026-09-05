"""`hermes_constants`, reduced to the reasoning helpers the bridge may call.

The real module is the chokepoint every Hermes surface resolves thinking
through, and the bridge asks it rather than knowing the vocabulary itself.
Copied here — the tuple in Hermes' own order, the same aliases for "off", and
a per-model override that outranks the global — so a bridge that guessed a
level list, or that read the global while an override was in force, fails.
"""

VALID_REASONING_EFFORTS = (
    "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
)


def parse_reasoning_effort(effort):
    """A level as a config dict, or None when there is nothing to say."""
    if effort is False:
        return {"enabled": False}
    if effort is None or effort is True:
        return None
    effort = str(effort)
    if not effort.strip():
        return None
    effort = effort.strip().lower()
    if effort in {"none", "false", "disabled"}:
        return {"enabled": False}
    if effort in VALID_REASONING_EFFORTS:
        return {"enabled": True, "effort": effort}
    return None


def resolve_per_model_reasoning_effort(model, overrides):
    if not isinstance(overrides, dict):
        return None
    for key in (str(model or ""), str(model or "").lower()):
        if key and key in overrides:
            return parse_reasoning_effort(overrides[key])
    return None


def resolve_reasoning_config(cfg, model=""):
    """Per-model override first, then the global `agent.reasoning_effort`."""
    cfg = cfg if isinstance(cfg, dict) else {}
    agent_cfg = cfg.get("agent")
    if not isinstance(agent_cfg, dict):
        agent_cfg = {}

    if not model:
        model_cfg = cfg.get("model")
        if isinstance(model_cfg, str):
            model = model_cfg.strip()
        elif isinstance(model_cfg, dict):
            model = str(model_cfg.get("default") or model_cfg.get("model") or "").strip()
        else:
            model = ""

    per_model = resolve_per_model_reasoning_effort(model, agent_cfg.get("reasoning_overrides") or {})
    if per_model is not None:
        return per_model
    return parse_reasoning_effort(agent_cfg.get("reasoning_effort", ""))
