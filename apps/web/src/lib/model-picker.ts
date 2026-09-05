/**
 * The Slick-side `/model` picker: the models an agent session told `serve` it
 * can run, grouped by provider, and the arguments the command takes.
 *
 * A session's model is one `provider::model` string all the way down, which
 * is what sets this apart from `hermes-panel.ts`, where a profile's default is
 * two separate fields.
 */

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export interface PickerModel {
  /** The whole id, `provider::model` when the agent reports it that way. */
  value: string;
  label: string;
  /** The model half of the id, which is what `--name` wants. */
  name: string;
}

export interface PickerProvider {
  value: string;
  label: string;
  models: PickerModel[];
}

function modelNameForChoice(choice: Record<string, unknown>, value: string): string {
  const explicitName = asText(choice.name);
  if (explicitName) return explicitName;

  const separator = value.indexOf('::');
  if (separator >= 0) return value.slice(separator + 2);

  return asText(choice.label) || value;
}

function providerForChoice(choice: Record<string, unknown>, value: string): string {
  const explicitGroup = asText(choice.group);
  if (explicitGroup) return explicitGroup;

  const separator = value.indexOf('::');
  return separator > 0 ? value.slice(0, separator) : 'default';
}

export function groupModelChoices(choices: unknown): PickerProvider[] {
  const providers: PickerProvider[] = [];
  const byProvider = new Map<string, PickerProvider>();
  const seenModels = new Set<string>();

  for (const raw of Array.isArray(choices) ? choices : []) {
    const choice: Record<string, unknown> = isRecord(raw) ? raw : {};
    const value = asText(choice.id || choice.value || choice.model);
    if (!value || seenModels.has(value)) continue;

    const provider = providerForChoice(choice, value);
    let providerEntry = byProvider.get(provider);
    if (!providerEntry) {
      providerEntry = {
        value: provider,
        label: asText(choice.groupLabel) || provider,
        models: [],
      };
      byProvider.set(provider, providerEntry);
      providers.push(providerEntry);
    }

    const name = modelNameForChoice(choice, value);
    providerEntry.models.push({
      value,
      label: asText(choice.label) || name,
      name,
    });
    seenModels.add(value);
  }

  return providers;
}

export interface ModelCommandArgs {
  provider: string;
  name: string;
  /** A flag typed with no value yet, which is the picker's cue to open on it. */
  pending: 'provider' | 'name' | null;
  flags: string[];
}

export function parseModelCommandArgs(rawArgs: unknown): ModelCommandArgs {
  const tokens = asText(rawArgs).split(/\s+/).filter(Boolean);
  const result: ModelCommandArgs = { provider: '', name: '', pending: null, flags: [] };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    const equalsIndex = token.indexOf('=');
    const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    let value = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : '';

    if (flag !== '--provider' && flag !== '--name') {
      result.flags.push(token);
      continue;
    }

    const next = tokens[index + 1];
    if (!value && equalsIndex < 0 && next !== undefined && !next.startsWith('--')) {
      value = next;
      index += 1;
    }

    if (flag === '--provider') result.provider = value;
    else result.name = value;

    if (!value) result.pending = flag === '--provider' ? 'provider' : 'name';
  }

  return result;
}

function matchingModel(
  models: readonly PickerModel[] | null | undefined,
  value: unknown
): PickerModel | null {
  const wanted = asText(value);
  return (
    (models ?? []).find(
      (model) => model.value === wanted || model.name === wanted || model.label === wanted
    ) ?? null
  );
}

export function findModelChoice(
  providers: readonly PickerProvider[] | null | undefined,
  provider: string,
  name: unknown
): PickerModel | null {
  const providerEntry = (providers ?? []).find((entry) => entry.value === provider);
  if (!providerEntry) return null;

  return matchingModel(providerEntry.models, name);
}

export function modelsForProvider(
  providers: readonly PickerProvider[] | null | undefined,
  provider: string
): PickerModel[] {
  return (providers ?? []).find((entry) => entry.value === provider)?.models ?? [];
}

/**
 * Choose the initial values for a picker that shows both fields at once.
 * Explicit command arguments win; otherwise preserve the running model when
 * it belongs to the selected provider, then fall back to the first model.
 */
export function modelPickerDefaults(
  providers: readonly PickerProvider[] | null | undefined,
  {
    provider = '',
    name = '',
    current = '',
  }: { provider?: string; name?: string; current?: string | null } = {}
): { provider: string; name: string } {
  const entries = providers ?? [];
  let providerEntry = entries.find((entry) => entry.value === asText(provider));
  if (!providerEntry && asText(name)) {
    providerEntry = entries.find((entry) => matchingModel(entry.models, name));
  }
  if (!providerEntry && asText(current)) {
    providerEntry = entries.find((entry) => matchingModel(entry.models, current));
  }
  providerEntry ||= entries[0];
  if (!providerEntry) return { provider: '', name: '' };

  const selected =
    matchingModel(providerEntry.models, name) ||
    matchingModel(providerEntry.models, current) ||
    providerEntry.models[0];
  return { provider: providerEntry.value, name: selected?.value ?? '' };
}

export function modelCommandPreview(
  provider: string,
  model: Partial<PickerModel> | null | undefined
): string {
  const modelName = asText(model?.name || model?.label || model?.value);
  return `/model --provider ${provider} --name ${modelName}`;
}
