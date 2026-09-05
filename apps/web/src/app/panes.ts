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

const WIDTH_KEY = 'slick.thread-width';
export const DEFAULT_THREAD_WIDTH = 400;
const MIN_WIDTH = 260;
/** The channel column never goes under this, however far the drag asks. */
const MIN_CHANNEL = 420;
/** Arrow-key step, in px. */
export const RESIZE_STEP = 16;

/** What was asked for, before it is squeezed to fit the window. */
let wanted = DEFAULT_THREAD_WIDTH;

/**
 * The rail is measured rather than read off `--rail-w`: it is the only other
 * fixed column, and a stale number here would let the channel be squeezed past
 * its minimum.
 */
function limits(): { min: number; max: number } {
  const rail = document.getElementById('rail')?.getBoundingClientRect().width ?? 0;
  const room = Math.round(window.innerWidth - rail - MIN_CHANNEL);
  return { min: MIN_WIDTH, max: Math.max(MIN_WIDTH, room) };
}

/** Put `width` on screen, clamped, and report what actually landed. */
export function applyThreadWidth(width: number): number {
  const { min, max } = limits();
  const clamped = Math.round(Math.min(Math.max(width, min), max));
  document.getElementById('app')?.style.setProperty('--thread-w', `${clamped}px`);
  const resizer = document.getElementById('thread-resizer');
  if (resizer) {
    resizer.setAttribute('aria-valuenow', String(clamped));
    resizer.setAttribute('aria-valuemin', String(min));
    resizer.setAttribute('aria-valuemax', String(max));
  }
  return clamped;
}

export function rememberThreadWidth(width: number): void {
  wanted = width;
  localStorage.setItem(WIDTH_KEY, String(width));
}

/** The width on screen right now, which a fresh drag or nudge starts from. */
export const currentThreadWidth = (): number =>
  document.getElementById('thread')?.getBoundingClientRect().width ?? wanted;

/** What was saved, or the shipped width. */
export function restoreThreadWidth(): number {
  const saved = Number(localStorage.getItem(WIDTH_KEY));
  wanted = Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_THREAD_WIDTH;
  return applyThreadWidth(wanted);
}

/**
 * Re-run the clamp without a resize event to hang it on.
 *
 * `limits()` measures the rail, so collapsing it frees up room the thread is
 * allowed to take back — but hiding the rail is a class change, and a class
 * change fires nothing. Whoever moves that column calls this.
 */
export function reflowPanes(): void {
  applyThreadWidth(wanted);
}
