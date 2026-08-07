/**
 * The live event fan-out (Server-Sent Events).
 *
 * The daemon is not the only writer — the CLI writes to the same SQLite file
 * directly so that `slick send` works even when no daemon is running. The hub
 * therefore *polls* the event log rather than relying on in-process hooks:
 * whatever wrote the row, every connected client sees it. Writes made through
 * the daemon call `wake()` and skip the wait entirely.
 */

const ACTIVE_POLL_MS = 250;
const IDLE_POLL_MS = 2000;
const HEARTBEAT_MS = 20_000;

export function createHub(ws, opts = {}) {
  const activePoll = opts.activePollMs ?? ACTIVE_POLL_MS;
  const idlePoll = opts.idlePollMs ?? IDLE_POLL_MS;
  const push = opts.push ?? null;
  /** @type {Set<{res: import('node:http').ServerResponse, cursor: number, channelId: string|null}>} */
  const clients = new Set();
  let timer = null;
  let heartbeat = null;
  let closed = false;
  // Independent of any connected browser tab — the whole point of a push
  // notification is to reach a phone that has no tab open at all.
  let notifiedCursor = ws.seq();

  function write(client, event) {
    if (client.channelId && event.channelId && event.channelId !== client.channelId) return;
    client.res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  function checkPush(latest) {
    if (!push || latest <= notifiedCursor) return;
    const events = ws.hydratedEvents({ since: notifiedCursor, limit: 200 });
    notifiedCursor = latest;
    for (const event of events) {
      if (event.type !== 'message.created' || event.message?.author?.kind !== 'agent') continue;
      const message = event.message;
      push
        .notify({
          title: message.channelSlug ? `${message.author.label} in #${message.channelSlug}` : message.author.label,
          body: message.text,
          url: './',
          tag: message.threadId,
        })
        .catch((err) => console.error('[slick] push notify failed:', err.message));
    }
  }

  function flush() {
    const latest = ws.seq();
    checkPush(latest);
    if (clients.size === 0) return;
    for (const client of clients) {
      if (client.cursor >= latest) continue;
      let cursor = client.cursor;
      // Drain in pages so a long-idle client cannot blow up a single write.
      for (let guard = 0; guard < 20 && cursor < latest; guard++) {
        const batch = ws.hydratedEvents({ since: cursor, limit: 200, channelId: client.channelId });
        if (batch.length === 0) break;
        for (const event of batch) write(client, event);
        cursor = batch[batch.length - 1].seq;
      }
      client.cursor = Math.max(cursor, latest);
    }
  }

  function schedule() {
    if (closed) return;
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      try {
        flush();
      } catch (err) {
        console.error('[slick] stream poll failed:', err.message);
      }
    }, clients.size > 0 ? activePoll : idlePoll);
    timer.unref?.();
  }

  /** Push immediately instead of waiting for the next tick. */
  function wake() {
    try {
      flush();
    } catch (err) {
      console.error('[slick] stream flush failed:', err.message);
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{since?: number|null, channelId?: string|null}} [options]
   */
  function subscribe(req, res, options = {}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    const latest = ws.seq();
    // `Last-Event-ID` is set automatically by EventSource when it reconnects,
    // so a dropped connection resumes without losing a single message.
    const lastEventId = Number(req.headers['last-event-id']);
    const since = Number.isFinite(lastEventId)
      ? lastEventId
      : options.since == null
        ? latest
        : Number(options.since);

    const client = { res, cursor: Math.max(0, Math.min(since, latest)), channelId: options.channelId ?? null };
    clients.add(client);

    res.write(`retry: 2000\ndata: ${JSON.stringify({ type: 'stream.ready', seq: latest, since: client.cursor })}\n\n`);

    const cleanup = () => {
      clients.delete(client);
      schedule();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);

    schedule();
    wake();
    return client;
  }

  schedule();
  heartbeat = setInterval(() => {
    for (const client of clients) client.res.write(': keepalive\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  function close() {
    closed = true;
    if (timer) clearInterval(timer);
    if (heartbeat) clearInterval(heartbeat);
    for (const client of clients) {
      try {
        client.res.end();
      } catch {
        /* client already gone */
      }
    }
    clients.clear();
  }

  return { subscribe, wake, close, get size() { return clients.size; } };
}
