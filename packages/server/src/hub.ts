/**
 * The live event fan-out (Server-Sent Events).
 *
 * The daemon is not the only writer — the CLI writes to the same SQLite file
 * directly so that `slick send` works even when no daemon is running. The hub
 * therefore *polls* the event log rather than relying on in-process hooks:
 * whatever wrote the row, every connected client sees it. Writes made through
 * the daemon call `wake()` and skip the wait entirely.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { errorMessage, type HydratedEvent, type JsonObject, type Workspace } from '@slick/core';

import type { PushService } from './push.ts';

const ACTIVE_POLL_MS = 250;
const IDLE_POLL_MS = 2000;
const HEARTBEAT_MS = 20_000;
const MAX_CLIENT_BUFFER_BYTES = 1_000_000;

export interface HubClient {
  res: ServerResponse;
  cursor: number;
  channelId: string | null;
}

export interface HubOptions {
  activePollMs?: number;
  idlePollMs?: number;
  push?: PushService | null;
}

export interface SubscribeOptions {
  since?: number | null;
  channelId?: string | null;
}

export function createHub(ws: Workspace, opts: HubOptions = {}) {
  const activePoll = opts.activePollMs ?? ACTIVE_POLL_MS;
  const idlePoll = opts.idlePollMs ?? IDLE_POLL_MS;
  const push = opts.push ?? null;
  const clients = new Set<HubClient>();
  let timer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let closed = false;
  // Independent of any connected browser tab — the whole point of a push
  // notification is to reach a phone that has no tab open at all.
  let notifiedCursor = ws.seq();

  /**
   * Stop serving a client and let it come back for itself.
   *
   * Deleting from the set mid-iteration is legal, and `flush()` is written to
   * notice; `schedule()` is here because the poll interval is chosen from
   * `clients.size`, and the `close` this `end()` provokes only arrives on a
   * later tick.
   */
  function dropClient(client: HubClient): void {
    clients.delete(client);
    try {
      client.res.end();
    } catch {
      /* already gone */
    }
    schedule();
  }

  /** @returns whether the client is still being served */
  function write(client: HubClient, event: HydratedEvent): boolean {
    // The return value of `write()` has been ignored here since the first
    // version, and that was fair while the only traffic was log rows: a client
    // too slow for those is a client that has already gone away, and the
    // socket closes soon enough to clean itself up. Streamed deltas are the
    // first pattern that can outrun a stalled socket faster than a close
    // arrives, and every unwritten frame sits in Node's buffer until it does.
    //
    // A megabyte behind is not a reader any more — but a log row is the one
    // thing that must not simply be skipped. `flush()` advances the cursor
    // whether or not the row went out, so a skipped row is a hole the client
    // never learns about and no reconnect ever fills. Ending the response is
    // the recoverable move instead: EventSource comes back within its retry
    // quoting the last id it really received, and the log replays the gap.
    if (client.res.writableLength > MAX_CLIENT_BUFFER_BYTES) {
      dropClient(client);
      return false;
    }
    if (client.channelId && event.channelId && event.channelId !== client.channelId) return true;
    client.res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    return true;
  }

  /**
   * Send a frame that is in no event log at all.
   *
   * Deliberately no `id:` line, following `stream.ready`, which has always gone
   * out without one. `id:` is precisely what the browser stores as
   * `Last-Event-ID`, and an ephemeral frame has no seq of its own to put there
   * — it would have to borrow one. A client that then reconnected quoting a
   * borrowed id would be claiming to have seen a row it never received, and
   * everything the log wrote up to that seq would be skipped for good. With no
   * `id:` the browser keeps the last real event id, so a stream that dropped
   * mid-answer resumes exactly where it would have if nothing had streamed.
   */
  function broadcast(frame: JsonObject, { channelId = null }: { channelId?: string | null } = {}): void {
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const client of clients) {
      // Skipped, where `write()` disconnects, and the asymmetry is the whole
      // point: a delta has no seq, so there is nothing for a reconnect to
      // resume from and nothing lost by never sending it. The message it was
      // a preview of arrives through the log either way.
      if (client.res.writableLength > MAX_CLIENT_BUFFER_BYTES) continue;
      if (client.channelId && channelId && channelId !== client.channelId) continue;
      client.res.write(payload);
    }
  }

  function checkPush(latest: number): void {
    if (!push || latest <= notifiedCursor) return;
    const events = ws.hydratedEvents({ since: notifiedCursor, limit: 200 });
    notifiedCursor = latest;
    for (const event of events) {
      const message = event.message;
      if (event.type !== 'message.created' || message?.author.kind !== 'agent') continue;
      push
        .notify({
          title: message.channelSlug
            ? `${message.author.label} in #${message.channelSlug}`
            : message.author.label,
          body: message.text,
          // Where the notification came from, so tapping it lands on the
          // message instead of the app's front door. The worker reads
          // channel/thread directly; `url` is the fallback for a cold start,
          // where there is no open window to route in place.
          channel: message.channelSlug ?? null,
          thread: message.threadId,
          url: message.channelSlug
            ? `./?channel=${encodeURIComponent(message.channelSlug)}` +
              `&thread=${encodeURIComponent(message.threadId)}`
            : './',
          tag: message.threadId,
        })
        .catch((err: unknown) => console.error('[slick] push notify failed:', errorMessage(err)));
    }
  }

  function flush(): void {
    const latest = ws.seq();
    checkPush(latest);
    if (clients.size === 0) return;
    for (const client of clients) {
      if (client.cursor >= latest) continue;
      let cursor = client.cursor;
      let serving = true;
      // Drain in pages so a long-idle client cannot blow up a single write.
      for (let guard = 0; guard < 20 && cursor < latest; guard++) {
        const batch = ws.hydratedEvents({ since: cursor, limit: 200, channelId: client.channelId });
        if (batch.length === 0) break;
        for (const event of batch) {
          if (write(client, event)) continue;
          serving = false;
          break;
        }
        if (!serving) break;
        cursor = batch[batch.length - 1]?.seq ?? cursor;
      }
      // A client `write()` gave up on is out of the set already, and its
      // cursor is left where it stopped rather than jumped to `latest` — the
      // point of hanging up was that it has *not* seen the rest.
      if (serving) client.cursor = Math.max(cursor, latest);
    }
  }

  function schedule(): void {
    if (closed) return;
    if (timer) clearInterval(timer);
    timer = setInterval(
      () => {
        try {
          flush();
        } catch (err) {
          console.error('[slick] stream poll failed:', errorMessage(err));
        }
      },
      clients.size > 0 ? activePoll : idlePoll
    );
    timer.unref();
  }

  /** Push immediately instead of waiting for the next tick. */
  function wake(): void {
    try {
      flush();
    } catch (err) {
      console.error('[slick] stream flush failed:', errorMessage(err));
    }
  }

  function subscribe(req: IncomingMessage, res: ServerResponse, options: SubscribeOptions = {}): HubClient {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();

    const latest = ws.seq();
    // `Last-Event-ID` is set automatically by EventSource when it reconnects,
    // so a dropped connection resumes without losing a single message.
    const lastEventId = Number(req.headers['last-event-id']);
    const since = Number.isFinite(lastEventId)
      ? lastEventId
      : options.since == null
        ? latest
        : Number(options.since);

    const client: HubClient = {
      res,
      cursor: Math.max(0, Math.min(since, latest)),
      channelId: options.channelId ?? null,
    };
    clients.add(client);

    res.write(
      `retry: 2000\ndata: ${JSON.stringify({ type: 'stream.ready', seq: latest, since: client.cursor })}\n\n`
    );

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
  heartbeat.unref();

  function close(): void {
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

  return {
    subscribe,
    broadcast,
    wake,
    close,
    get size() {
      return clients.size;
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
