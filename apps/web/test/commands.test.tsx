/**
 * Slash-command autocomplete, as a person types it.
 */

import assert from 'node:assert/strict';
import { fireEvent, render } from '@testing-library/react';
import { describe, test } from 'vitest';

import { Composer } from '../src/features/messages/Composer.tsx';
import {
  commandMatches,
  findCommand,
  insertCommand,
  type CommandEntry,
} from '../src/features/messages/commands.ts';

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Type into the box the way a person does: the value lands, then the input event. */
function type(textarea: HTMLTextAreaElement, value: string) {
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  fireEvent.input(textarea);
}

function composer({
  commands,
  load = () => Promise.resolve(),
}: {
  commands: () => CommandEntry[];
  load?: () => Promise<void>;
}) {
  const utils = render(
    <Composer
      where="main"
      placeholder="Message"
      onSubmit={() => Promise.resolve()}
      suggestions={() => []}
      commands={commands}
      loadCommands={load}
    />
  );
  const textarea = utils.container.querySelector<HTMLTextAreaElement>('#composer-input')!;
  const menu = utils.container.querySelector<HTMLUListElement>('#command-menu-main')!;
  return { ...utils, textarea, menu };
}

describe('the rules', () => {
  test('only a slash at the very start of the box opens a menu', () => {
    assert.deepEqual(findCommand('/st', 3), { query: 'st' });
    assert.equal(findCommand('a /st', 5), null);
    assert.equal(findCommand('/status now', 11), null, 'past the name; the arguments are the agent’s');
  });

  test('runnable commands come first, and the list stops at ten', () => {
    const all: CommandEntry[] = [
      { name: 'config', where: 'terminal' },
      { name: 'clear', where: 'run' },
      { name: 'compact', aliases: ['c'] },
    ];
    assert.deepEqual(
      commandMatches(all, 'c').map((c) => c.name),
      ['clear', 'compact', 'config']
    );
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `cmd${i}` }));
    assert.equal(commandMatches(many, 'cmd').length, 10);
  });

  test('picking one leaves just the name and a space', () => {
    assert.deepEqual(insertCommand('/sta', 'status'), { value: '/status ', caret: 8 });
    assert.deepEqual(insertCommand('/sta with args', 'status'), { value: '/status with args', caret: 8 });
  });
});

describe('the menu', () => {
  test('stays visible and refreshes when its async command list arrives', async () => {
    let commands: CommandEntry[] = [];
    let resolveList!: () => void;
    const { textarea, menu } = composer({
      commands: () => commands,
      load: () =>
        new Promise<void>((resolve) => {
          resolveList = resolve;
        }),
    });

    type(textarea, '/st');
    assert.equal(menu.hidden, false);
    assert.match(menu.textContent ?? '', /Loading commands/);

    commands = [{ name: 'status', summary: 'Show status' }];
    resolveList();
    await flush();

    assert.equal(menu.hidden, false);
    assert.match(menu.textContent ?? '', /\/status/);
    assert.match(menu.textContent ?? '', /Show status/);
  });

  test('a command marked unavailable cannot be selected', () => {
    const { textarea, menu } = composer({ commands: () => [{ name: 'config', where: 'terminal' }] });

    type(textarea, '/c');
    const rows = menu.querySelectorAll('li[role="option"]');
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.className, /is-off/);
    assert.equal(rows[0]!.getAttribute('aria-disabled'), 'true');

    fireEvent.mouseDown(rows[0]!);
    assert.equal(textarea.value, '/c');
  });

  test('a Slick picker command remains selectable even when its Hermes scope is session-only', () => {
    const { textarea, menu } = composer({
      commands: () => [{ name: 'model', where: 'session', picker: 'model' }],
    });

    type(textarea, '/m');
    const rows = menu.querySelectorAll('li[role="option"]');
    assert.equal(rows.length, 1);
    assert.doesNotMatch(rows[0]!.className, /is-off/);
    assert.match(menu.textContent ?? '', /choose provider and model/);

    fireEvent.mouseDown(rows[0]!);
    assert.equal(textarea.value, '/model ');
  });

  test('arrow keys move the selection and Escape closes it', () => {
    const { textarea, menu } = composer({ commands: () => [{ name: 'a' }, { name: 'ab' }] });
    type(textarea, '/a');
    assert.equal(menu.querySelectorAll('li').length, 2);
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    assert.match(menu.querySelectorAll('li')[1]!.className, /is-sel/);
    fireEvent.keyDown(textarea, { key: 'Escape' });
    assert.equal(menu.hidden, true);
  });
});

test('the thread composer includes the same command affordances as the main composer', () => {
  const { container } = render(
    <Composer
      where="thread"
      placeholder="Reply…"
      onSubmit={() => Promise.resolve()}
      suggestions={() => []}
      commands={() => []}
      loadCommands={() => Promise.resolve()}
    />
  );
  assert.ok(container.querySelector('#command-menu-thread'));
  assert.ok(container.querySelector('#thread-composer-out'));
  assert.ok(container.querySelector('#mention-menu-thread'));
});
