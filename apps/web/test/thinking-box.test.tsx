/**
 * The thinking box's disclosure: born collapsed, opened by a press, and — the
 * part that only shows up under a live stream — still open after the row it
 * sits in has been redrawn a dozen times.
 */

import assert from 'node:assert/strict';
import { act, fireEvent, render } from '@testing-library/react';
import { Provider } from 'jotai';
import { beforeEach, describe, test } from 'vitest';

import { ThinkingBox } from '../src/components/ThinkingBox.tsx';
import { emptyThink, type ThinkingView } from '../src/lib/thinking.ts';
import { store } from '../src/store.ts';
import { resetThinkState } from '../src/think-state.ts';

const think = (phase: ThinkingView['phase'], steps = 1): ThinkingView => ({
  title: 'Working out what took the canary down',
  phase,
  steps: Array.from({ length: steps }, (_, i) => ({
    id: `t${i}`,
    title: `Step ${i}`,
    status: phase === 'streaming' && i === steps - 1 ? 'in_progress' : 'complete',
    details: [],
    output: '',
    sources: [],
  })),
});

function box(view: ThinkingView, surface: 'timeline' | 'thread' = 'timeline', key = 'msg_1') {
  return render(
    <Provider store={store}>
      <ThinkingBox think={view} thinkKey={key} surface={surface} />
    </Provider>
  );
}

const head = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('.think__head')!;

beforeEach(() => resetThinkState());

describe('open or shut', () => {
  test('a finished box is born collapsed, and says so', () => {
    const { container } = box(think('done'));
    assert.equal(head(container).getAttribute('aria-expanded'), 'false');
    assert.equal(container.querySelector('.think__chev')?.textContent, '▸');
    assert.equal(container.querySelector('.think')?.getAttribute('data-phase'), 'done');
  });

  test('a failed box is born open: the step that broke is the one worth seeing', () => {
    const { container } = box(think('error'));
    assert.equal(head(container).getAttribute('aria-expanded'), 'true');
  });

  test('a press opens it, and a redraw of the same phase leaves the choice alone', () => {
    const { container, rerender } = box(think('streaming'));
    fireEvent.click(head(container));
    assert.equal(head(container).getAttribute('aria-expanded'), 'true');

    // The row is rebuilt — a reply landed three rows down — with the same
    // phase. The reader's choice stands.
    rerender(
      <Provider store={store}>
        <ThinkingBox think={think('streaming', 3)} thinkKey="msg_1" surface="timeline" />
      </Provider>
    );
    assert.equal(head(container).getAttribute('aria-expanded'), 'true');
  });

  test('finishing hands the space back to the answer; failing does the opposite', async () => {
    const { container, rerender } = box(think('streaming'));
    fireEvent.click(head(container));
    assert.equal(head(container).getAttribute('aria-expanded'), 'true');

    await act(async () => {
      rerender(
        <Provider store={store}>
          <ThinkingBox think={think('done')} thinkKey="msg_1" surface="timeline" />
        </Provider>
      );
    });
    assert.equal(head(container).getAttribute('aria-expanded'), 'false', 'done closes it');

    await act(async () => {
      rerender(
        <Provider store={store}>
          <ThinkingBox think={think('error')} thinkKey="msg_1" surface="timeline" />
        </Provider>
      );
    });
    assert.equal(head(container).getAttribute('aria-expanded'), 'true', 'an error opens it');
  });

  test('the two copies of a thread root share one state but not one id', () => {
    const { container } = render(
      <Provider store={store}>
        <div id="messages">
          <ThinkingBox think={think('done')} thinkKey="msg_1" surface="timeline" />
        </div>
        <div id="thread-body">
          <ThinkingBox think={think('done')} thinkKey="msg_1" surface="thread" />
        </div>
      </Provider>
    );
    const heads = container.querySelectorAll<HTMLButtonElement>('.think__head');
    const bodies = container.querySelectorAll<HTMLElement>('.think__body');
    assert.notEqual(
      bodies[0]!.id,
      bodies[1]!.id,
      'aria-controls would otherwise resolve to whichever came first'
    );
    assert.ok(bodies[0]!.id.startsWith('think-timeline-'));
    assert.ok(bodies[1]!.id.startsWith('think-thread-'));
    assert.equal(heads[0]!.getAttribute('aria-controls'), bodies[0]!.id);

    fireEvent.click(heads[1]!);
    assert.equal(heads[0]!.getAttribute('aria-expanded'), 'true', 'opening one opens the other');
    assert.equal(heads[1]!.getAttribute('aria-expanded'), 'true');
  });
});

describe('the steps', () => {
  test('a finished box settles any step still claiming to run', () => {
    const view = { ...think('done', 2), steps: [...think('done', 2).steps] };
    view.steps[1] = { ...view.steps[1]!, status: 'in_progress' };
    const { container } = box(view);
    const marks = [...container.querySelectorAll('.think__step')].map((s) => s.getAttribute('data-status'));
    assert.deepEqual(marks, ['complete', 'complete']);
  });

  test('past twelve, the oldest fold away behind one row', () => {
    const { container } = box(think('done', 15));
    const rows = container.querySelectorAll<HTMLElement>('.think__step');
    assert.equal(rows.length, 15, 'every step is in the document');
    assert.equal([...rows].filter((r) => r.hidden).length, 3, 'the oldest three are folded');
    const more = container.querySelector<HTMLButtonElement>('.think__more button')!;
    assert.match(more.textContent ?? '', /Show all 15 steps/);
    fireEvent.click(more);
    assert.equal(
      [...container.querySelectorAll<HTMLElement>('.think__step')].filter((r) => r.hidden).length,
      0
    );
  });

  test('every step says its state out loud, beside a mark that says nothing', () => {
    const { container } = box(think('streaming', 2));
    const sr = [...container.querySelectorAll('.think__sr')].map((n) => n.textContent);
    assert.deepEqual(sr, [', done', ', in progress']);
    assert.equal(container.querySelector('.think__step .think__mark')?.getAttribute('aria-hidden'), 'true');
  });

  test('a box with no steps and no title still has a line to say', () => {
    const { container } = box({ ...emptyThink(), phase: 'streaming' });
    assert.equal(container.querySelector('.think__title')?.textContent, 'Thinking…');
  });
});
