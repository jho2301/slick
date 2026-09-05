import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  groupModelChoices,
  modelPickerDefaults,
  modelsForProvider,
  parseModelCommandArgs,
} from '../src/features/hermes/model-picker.ts';

test('groups provider-qualified model choices without losing their full ids', () => {
  const providers = groupModelChoices([
    { id: 'openai-codex::gpt-5.6-luna', label: 'gpt-5.6-luna', group: 'openai-codex' },
    { id: 'openai-codex::gpt-5.6-sol', label: 'gpt-5.6-sol', group: 'openai-codex' },
    { id: 'anthropic::claude-sonnet-5', label: 'claude-sonnet-5', group: 'anthropic' },
    { id: 'openai-codex::gpt-5.6-luna', label: 'duplicate', group: 'openai-codex' },
  ]);

  assert.deepEqual(providers, [
    {
      value: 'openai-codex',
      label: 'openai-codex',
      models: [
        { value: 'openai-codex::gpt-5.6-luna', label: 'gpt-5.6-luna', name: 'gpt-5.6-luna' },
        { value: 'openai-codex::gpt-5.6-sol', label: 'gpt-5.6-sol', name: 'gpt-5.6-sol' },
      ],
    },
    {
      value: 'anthropic',
      label: 'anthropic',
      models: [{ value: 'anthropic::claude-sonnet-5', label: 'claude-sonnet-5', name: 'claude-sonnet-5' }],
    },
  ]);
});

test('parses provider and model flags, including an incomplete flag ready for a picker', () => {
  assert.deepEqual(parseModelCommandArgs('--provider openai-codex --name gpt-5.6-luna'), {
    provider: 'openai-codex',
    name: 'gpt-5.6-luna',
    pending: null,
    flags: [],
  });
  assert.deepEqual(parseModelCommandArgs('--provider'), {
    provider: '',
    name: '',
    pending: 'provider',
    flags: [],
  });
  assert.deepEqual(parseModelCommandArgs('--provider openai-codex --name'), {
    provider: 'openai-codex',
    name: '',
    pending: 'name',
    flags: [],
  });
});

const providers = [
  {
    value: 'openai-codex',
    label: 'openai-codex',
    models: [
      { value: 'openai-codex::gpt-5.6-luna', label: 'gpt-5.6-luna', name: 'gpt-5.6-luna' },
      { value: 'openai-codex::gpt-5.6-sol', label: 'gpt-5.6-sol', name: 'gpt-5.6-sol' },
    ],
  },
  {
    value: 'anthropic',
    label: 'anthropic',
    models: [{ value: 'anthropic::claude-sonnet-5', label: 'claude-sonnet-5', name: 'claude-sonnet-5' }],
  },
];

test('the initial /model picker has a provider and a visible model selection', () => {
  assert.deepEqual(modelPickerDefaults(providers), {
    provider: 'openai-codex',
    name: 'openai-codex::gpt-5.6-luna',
  });
});

test('provider changes replace the visible model choices', () => {
  assert.deepEqual(modelsForProvider(providers, 'anthropic'), [
    { value: 'anthropic::claude-sonnet-5', label: 'claude-sonnet-5', name: 'claude-sonnet-5' },
  ]);
});
