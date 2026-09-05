import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  modelPickerDefaults,
  modelsForProvider,
} from '../js/model-picker.js';

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
    models: [
      { value: 'anthropic::claude-sonnet-5', label: 'claude-sonnet-5', name: 'claude-sonnet-5' },
    ],
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
