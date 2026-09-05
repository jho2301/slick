function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function modelNameForChoice(choice, value) {
  const explicitName = asText(choice?.name);
  if (explicitName) return explicitName;

  const separator = value.indexOf('::');
  if (separator >= 0) return value.slice(separator + 2);

  return asText(choice?.label) || value;
}

function providerForChoice(choice, value) {
  const explicitGroup = asText(choice?.group);
  if (explicitGroup) return explicitGroup;

  const separator = value.indexOf('::');
  return separator > 0 ? value.slice(0, separator) : 'default';
}

export function groupModelChoices(choices) {
  const providers = [];
  const byProvider = new Map();
  const seenModels = new Set();

  for (const choice of Array.isArray(choices) ? choices : []) {
    const value = asText(choice?.id || choice?.value || choice?.model);
    if (!value || seenModels.has(value)) continue;

    const provider = providerForChoice(choice, value);
    let providerEntry = byProvider.get(provider);
    if (!providerEntry) {
      providerEntry = {
        value: provider,
        label: asText(choice?.groupLabel) || provider,
        models: [],
      };
      byProvider.set(provider, providerEntry);
      providers.push(providerEntry);
    }

    const name = modelNameForChoice(choice, value);
    providerEntry.models.push({
      value,
      label: asText(choice?.label) || name,
      name,
    });
    seenModels.add(value);
  }

  return providers;
}

export function parseModelCommandArgs(rawArgs) {
  const tokens = asText(rawArgs).split(/\s+/).filter(Boolean);
  const result = { provider: '', name: '', pending: null, flags: [] };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equalsIndex = token.indexOf('=');
    const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    let value = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : '';

    if (flag !== '--provider' && flag !== '--name') {
      result.flags.push(token);
      continue;
    }

    if (!value && equalsIndex < 0 && index + 1 < tokens.length && !tokens[index + 1].startsWith('--')) {
      value = tokens[index + 1];
      index += 1;
    }

    if (flag === '--provider') result.provider = value;
    else result.name = value;

    if (!value) result.pending = flag.slice(2);
  }

  return result;
}

function matchingModel(models, value) {
  const wanted = asText(value);
  return (Array.isArray(models) ? models : []).find((model) => (
    model.value === wanted || model.name === wanted || model.label === wanted
  )) || null;
}

export function findModelChoice(providers, provider, name) {
  const providerEntry = (Array.isArray(providers) ? providers : [])
    .find((entry) => entry.value === provider);
  if (!providerEntry) return null;

  return matchingModel(providerEntry.models, name);
}

export function modelsForProvider(providers, provider) {
  return (Array.isArray(providers) ? providers : [])
    .find((entry) => entry.value === provider)?.models ?? [];
}

/**
 * Choose the initial values for a picker that shows both fields at once.
 * Explicit command arguments win; otherwise preserve the running model when
 * it belongs to the selected provider, then fall back to the first model.
 */
export function modelPickerDefaults(providers, { provider = '', name = '', current = '' } = {}) {
  const entries = Array.isArray(providers) ? providers : [];
  let providerEntry = entries.find((entry) => entry.value === asText(provider));
  if (!providerEntry && asText(name)) {
    providerEntry = entries.find((entry) => matchingModel(entry.models, name));
  }
  if (!providerEntry && asText(current)) {
    providerEntry = entries.find((entry) => matchingModel(entry.models, current));
  }
  providerEntry ||= entries[0];
  if (!providerEntry) return { provider: '', name: '' };

  const selected = matchingModel(providerEntry.models, name)
    || matchingModel(providerEntry.models, current)
    || providerEntry.models?.[0];
  return { provider: providerEntry.value, name: selected?.value ?? '' };
}

export function modelCommandPreview(provider, model) {
  const modelName = asText(model?.name || model?.label || model?.value);
  return `/model --provider ${provider} --name ${modelName}`;
}
