/**
 * The disclosure box above an agent's answer: what it did on the way, as the
 * steps it announced, in the order it announced them.
 *
 * Shared by a finished message and an answer still arriving — they are the
 * same thing at different phases, and `thinkKey` is only how the disclosure
 * state finds its way back to the right one. A thread root is drawn in the
 * channel and again at the top of the pane, so the two copies must not both
 * claim the id their heads point `aria-controls` at — while the open state
 * stays keyed on the message alone, because they are the same box and
 * opening one opens the other.
 */

import type { StepStatus, ThinkingPhase } from '@slick/core';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState } from 'react';

import { thinkUiAtoms } from '../../app/atoms.ts';
import { settle, stepStatusLabel, type ThinkingStepView, type ThinkingView } from './thinking.ts';
import { store } from '../../app/store.ts';
import { resolveThinkOpen, setThinkSaid, thinkSaid, toggleThink } from './think-state.ts';
import type { Surface } from '../../app/types.ts';

/** Steps past this many are folded away behind one "Show all" row. */
const STEP_SOFT_CAP = 12;

/** At most one spoken update per box per this long. */
const ANNOUNCE_EVERY_MS = 1500;

/** What the mark beside the summary line is doing, in step vocabulary. */
const phaseStatus = (phase: ThinkingPhase): StepStatus =>
  phase === 'done' ? 'complete' : phase === 'error' ? 'error' : 'in_progress';

/**
 * The summary line when the agent authored none. Present progressive while it
 * runs, past tense once it has stopped — and never a duration, which would
 * quietly turn "here is my working" into "here is how long I took".
 */
const phaseTitle = (phase: ThinkingPhase): string =>
  phase === 'done' ? 'Finished thinking' : phase === 'error' ? 'Thinking stopped' : 'Thinking…';

/** What a screen reader should be told is happening, in one short line. */
function announcement(think: ThinkingView): string {
  if (think.phase === 'done') return 'Finished thinking';
  if (think.phase === 'error') return 'Thinking stopped on an error';
  const running = [...think.steps].reverse().find((step) => step.status !== 'complete');
  return running?.title || think.title || 'Thinking…';
}

/**
 * Say the step, not the characters.
 *
 * Two rules are doing the work here. Assistive tech watches a live region for
 * *changes*, and the first content of a brand-new node is not a change — so
 * text that is worth announcing goes in one turn after the box is built, once
 * the region is really in the document, and text that has already been said
 * goes in synchronously, where it stays silent. And a box with a dozen quick
 * steps would otherwise talk over itself, so nothing is announced twice within
 * `ANNOUNCE_EVERY_MS` — except a phase change, which is the one update nobody
 * should miss.
 */
function announce(region: HTMLElement, key: string, think: ThinkingView): void {
  const text = announcement(think);
  const said = thinkSaid(key);
  // Scrolling back through a channel is not a channel full of things
  // finishing. A box whose very first sight is already done or failed has no
  // transition to report, so it is recorded as said without ever being said —
  // otherwise opening a channel with a dozen old answers queues a dozen
  // "Finished thinking"s at a reader who asked for none of them.
  if (!said && think.phase !== 'streaming') {
    setThinkSaid(key, { text, phase: think.phase, at: Date.now() });
    region.textContent = text;
    return;
  }
  if (said?.text === text) {
    region.textContent = text;
    return;
  }
  if (said?.phase === think.phase && Date.now() - said.at < ANNOUNCE_EVERY_MS) return;
  setThinkSaid(key, { text, phase: think.phase, at: Date.now() });
  setTimeout(() => {
    region.textContent = text;
  }, 0);
}

function ThinkStep({ step, hidden }: { step: ThinkingStepView; hidden: boolean }) {
  return (
    <li className="think__step" data-status={step.status} data-id={step.id} hidden={hidden}>
      <span className="think__mark" data-status={step.status} aria-hidden="true" />
      <span className="think__step-title">{step.title}</span>
      {/* The mark is decoration and says so; this is the same information as
          plain text, sitting inside the step it belongs to. */}
      <span className="think__sr">{stepStatusLabel(step)}</span>
      {step.details.length > 0 ? (
        <ul className="think__details">
          {step.details.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      {step.output ? <p className="think__output">{step.output}</p> : null}
      {step.sources.length > 0 ? (
        <ul className="think__sources">
          {step.sources.map((source, i) => (
            <li key={i}>
              {/* `_blank` and a stripped referrer, the same terms every link the
                  markdown renderer emits goes out on. */}
              <a className="think__source" href={source.url} target="_blank" rel="noreferrer noopener">
                {source.title}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ThinkingBox({
  think,
  thinkKey,
  surface,
}: {
  think: ThinkingView;
  thinkKey: string;
  surface: Surface;
}) {
  // A stream ends by stopping, so a finished blob can still be carrying a step
  // that claims to be running. A transcript must never hold a live spinner.
  const shown = think.phase === 'streaming' ? think : settle(think, think.phase);
  const seen = useAtomValue(thinkUiAtoms(thinkKey));
  const resolved = resolveThinkOpen(seen, shown.phase);
  useEffect(() => {
    if (resolved !== seen) store.set(thinkUiAtoms(thinkKey), resolved);
  }, [resolved, seen, thinkKey]);
  const open = resolved.open;
  const bodyId = `think-${surface}-${thinkKey}-body`;

  // The tail is what stays visible rather than the head: a running box
  // appends its newest step at the bottom, and a cap that kept the first
  // twelve would leave a live box frozen on twelve finished rows while the
  // interesting one happens off-list. The way back to the rest sits where
  // they were cut.
  const [showAll, setShowAll] = useState(false);
  const folded = showAll ? 0 : Math.max(0, shown.steps.length - STEP_SOFT_CAP);

  // A sibling of the body, never inside it: a region that is collapsed away
  // with the thing it describes announces nothing at the moment it matters.
  const region = useRef<HTMLParagraphElement>(null);
  const text = announcement(shown);
  useEffect(() => {
    if (region.current) announce(region.current, thinkKey, shown);
    // `text` and the phase are what the announcement is made of; the object
    // itself is fresh every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thinkKey, text, shown.phase]);

  return (
    <div className="think" data-phase={shown.phase} data-think-key={thinkKey}>
      {/* `aria-expanded` and nothing else: the stylesheet collapses the body off
          the head's own attribute, so this is the state and the animation at
          once. Setting `hidden` here as well would take the steps out of the
          accessibility tree and out of the transition with them. */}
      <button
        className="think__head"
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => toggleThink(thinkKey, shown.phase)}
      >
        <span className="think__mark" data-status={phaseStatus(shown.phase)} aria-hidden="true" />
        <span className="think__title">{shown.title || phaseTitle(shown.phase)}</span>
        <span className="think__chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      <div className="think__body" id={bodyId} role="group" aria-label="Thinking steps">
        <ol className="think__steps">
          {folded > 0 ? (
            <li className="think__more">
              <button type="button" onClick={() => setShowAll(true)}>
                Show all {shown.steps.length} steps
              </button>
            </li>
          ) : null}
          {shown.steps.map((step, index) => (
            <ThinkStep key={step.id} step={step} hidden={index < folded} />
          ))}
        </ol>
      </div>
      <p className="think__live" aria-live="polite" aria-atomic="true" ref={region} />
    </div>
  );
}
