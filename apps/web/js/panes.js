/**
 * The draggable split between the channel and the thread pane.
 *
 * The width is one CSS variable on #app, so a drag is a single style write per
 * frame and the grid does the rest of the work.
 *
 * What you dragged to is what gets remembered — the clamp that keeps the
 * channel readable is re-applied on every window resize rather than saved, so
 * squeezing the window narrow and pulling it wide again gives back the width
 * you picked instead of the squeezed one.
 */

import { $ } from './ui.js';

const WIDTH_KEY = 'slick.thread-width';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 260;
/** The channel column never goes under this, however far the drag asks. */
const MIN_CHANNEL = 420;
/** Arrow-key step, in px. */
const STEP = 16;

/** What was asked for, before it is squeezed to fit the window. */
let wanted = DEFAULT_WIDTH;

/**
 * The rail is measured rather than read off `--rail-w`: it is the only other
 * fixed column, and a stale number here would let the channel be squeezed past
 * its minimum.
 */
function limits() {
  const rail = $('#rail').getBoundingClientRect().width;
  const room = Math.round(window.innerWidth - rail - MIN_CHANNEL);
  return { min: MIN_WIDTH, max: Math.max(MIN_WIDTH, room) };
}

/** Put `width` on screen, clamped, and report what actually landed. */
function apply(width) {
  const { min, max } = limits();
  const clamped = Math.round(Math.min(Math.max(width, min), max));
  $('#app').style.setProperty('--thread-w', `${clamped}px`);
  const resizer = $('#thread-resizer');
  resizer.setAttribute('aria-valuenow', String(clamped));
  resizer.setAttribute('aria-valuemin', String(min));
  resizer.setAttribute('aria-valuemax', String(max));
  return clamped;
}

function remember(width) {
  wanted = width;
  localStorage.setItem(WIDTH_KEY, String(width));
}

/** The width on screen right now, which a fresh drag or nudge starts from. */
const currentWidth = () => $('#thread').getBoundingClientRect().width;

function startDrag(event) {
  if (event.button !== 0) return;
  const resizer = $('#thread-resizer');
  resizer.classList.add('is-dragging');
  document.body.classList.add('is-resizing');
  // Stops the press from starting a text selection in the timeline behind it.
  event.preventDefault();

  const startX = event.clientX;
  const startWidth = currentWidth();
  const stop = new AbortController();
  const { signal } = stop;
  let landed = startWidth;

  // On the window rather than the handle: the pointer outruns a 7px column on
  // any quick drag, and every frame after that would otherwise be somebody
  // else's event.
  window.addEventListener(
    'pointermove',
    (move) => {
      // The thread is the right-hand column, so dragging left grows it.
      landed = apply(startWidth + (startX - move.clientX));
    },
    { signal }
  );

  const end = () => {
    stop.abort();
    resizer.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing');
    remember(landed);
  };
  window.addEventListener('pointerup', end, { signal });
  window.addEventListener('pointercancel', end, { signal });
}

export function initPaneResizer() {
  const resizer = $('#thread-resizer');
  const saved = Number(localStorage.getItem(WIDTH_KEY));
  wanted = Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_WIDTH;
  apply(wanted);

  resizer.addEventListener('pointerdown', startDrag);
  // A double-click is the usual way back to the shipped width; hunting for it
  // by hand is not something anyone should have to do.
  resizer.addEventListener('dblclick', () => remember(apply(DEFAULT_WIDTH)));

  resizer.addEventListener('keydown', (event) => {
    // Left grows the thread, same as dragging the handle that way.
    const step = event.key === 'ArrowLeft' ? STEP : event.key === 'ArrowRight' ? -STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    remember(apply(currentWidth() + step));
  });

  // Re-clamp, but against the width that was asked for rather than the one on
  // screen — a window pulled wide again should restore it.
  window.addEventListener('resize', () => apply(wanted));
}
