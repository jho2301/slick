# Slick

A Slack-shaped workspace for one person and their AI agents.

Channels, threads and messages, in a desktop app _and_ a CLI — over the same
workspace, live in both directions. You type in the app; your agent answers
from a terminal and the reply appears as you watch. The agent gets a **history
key** so it can stop, be restarted next week, and pick the conversation up
exactly where it left off.

Everything lives in one SQLite file. No account, no server to rent, no network.

```
┌──────────────┐         ┌───────────────┐         ┌──────────────┐
│ desktop app  │──HTTP──▶│  slickd       │         │  slick CLI   │
│ (Electron)   │◀──SSE───│  (localhost)  │         │  (you, agents)│
└──────────────┘         └───────┬───────┘         └──────┬───────┘
                                 │                        │
                                 ▼                        ▼
                          ~/.slick/slick.db  ◀────────────┘
```

The CLI writes to the database directly, so `slick send` works whether or not
anything else is running. The daemon watches the same file and pushes every
change to the app, whoever made it.

---

## Install

Needs Node 22.5 or newer (for the built-in `node:sqlite` — there is nothing to
compile).

```bash
npm install
npm link --workspace @slick/cli   # optional: puts `slick` on your PATH
```

Without linking, use `npm run slick -- <args>` or
`node packages/cli/bin/slick.js <args>`.

## Two minutes

```bash
slick init --user "Your Name"
slick send general "First message"
slick app                          # opens the desktop app
```

`slick app` starts the daemon and opens the Electron window. If Electron is not
installed it opens the same interface in your browser — same UI, same URL, and
the same thing your phone will talk to later.

## Your agent joins

```bash
# Once, ever. Write the key down.
KEY=$(slick agent start --agent claude --channel general -q)
echo $KEY        # slk_h1_rntwr3q9cawz6q8adye1
```

Then, in every run after that — a new process, no memory of the last one:

```bash
slick agent resume $KEY --json     # what did I miss, and what was I doing?
slick agent pull   $KEY --json     # read new messages, mark them read
slick agent post   $KEY "on it"    # say something
slick agent state set $KEY step=verifying
```

`resume` peeks — it never marks anything read — so an agent can safely call it
at the top of every run to re-orient. `pull` is the one that advances the
cursor. An agent never re-reads a message it has already handled, and never
misses one, because the cursor lives in the database rather than in the agent.

Full protocol for agents: **[AGENTS.md](./AGENTS.md)**.

That loop is meant to be driven by the agent itself, run after run. If you'd
rather Slick made the call for you — actually invoke the agent the moment
someone `@mentions` it, and post back whatever it says — run:

```bash
slick agent serve $KEY
```

It watches the session, and on every new `@claude` (by default; `--all` to
answer everything) it spawns `claude -p` with the recent conversation as
context, resuming the same `claude` conversation across turns, and replies
into the thread with whatever came back. Because that one transcript is
resumed forever, everything in the prompt is paid for again on every turn, so
the agent's saved `state` is re-sent only when it has actually changed.
`--dry-run` shows you the prompt without calling or posting anything; `--cmd`
points it at a different binary for other agents. It does not hand the child
process the ability to touch Slick itself — that stays between you and whatever
tool permissions you give it with `--permission-mode` / `--allowed-tools` /
`--dangerously-skip-permissions`.

---

## The CLI

```
Talking
  send <channel> <text…>        post a message           (--thread to reply)
  read <channel>                read a channel           (--limit, --before)
  thread show|reply <id>        open or reply to a thread
  search <terms…>               search messages
  tail                          follow the workspace live

Organising
  channel list|create|show|update|archive|unarchive|delete
  category list|create|show|update|move|reorder|collapse|delete
  message post|list|show|edit|delete
  status                        channels, activity, agents
  init                          create the workspace

Agents
  agent start|sessions|resume|pull|post|reply|state|ack|watch|serve|end

Apps
  app                           open the desktop app
  daemon status|start|stop|restart|log|url
  serve                         run the server in the foreground
  doctor                        check that everything is wired up
```

Every command takes `--json`. Anything a person can do, an agent can do.

```bash
slick send general "deploy is green"
git log -1 --oneline | slick send general -
slick read general --limit 5 --json
slick search cache --channel deploys
slick tail --json | while read -r line; do …; done
```

Once you have more than a handful of channels, group them into sidebar
sections:

```bash
slick category create Engineering
slick category move deploys engineering       # "none" takes it back out
slick category reorder engineering product    # top to bottom in the sidebar
slick category list
```

A channel is in at most one category; anything in none of them sits under
"Channels" at the bottom. Deleting a category never touches its channels.

Useful global flags: `--home <dir>` (a different workspace), `--remote <url>`
(drive a daemon over HTTP instead of the local file), `-q` (print only the
essential value, for `$(…)`), `--no-color`.

Exit codes: `0` ok, `2` bad usage, `4` not found, `5` conflict, `6`
unreachable, `1` everything else.

## The desktop app

- Channel sidebar with unread counts, plus every agent session and its history
  key (one click to copy).
- Collapsible categories: drag a channel between sections to regroup it, and
  the fold state sticks (it lives in the database, not the browser).
- Threads in a side pane, live reply counts.
- Create, rename, re-topic, recategorise, archive and delete channels; edit and
  delete messages inline.
- `⌘K` jumps between channels and searches messages in the same box.
- Live updates over SSE — including changes made by the CLI while you watch.
- A "claude is typing…" indicator, on the message and in its thread, while
  `slick agent serve` is waiting on a reply.
- Light and dark, following the system.

## Where things are

| What                   | Where                                            |
| ---------------------- | ------------------------------------------------ |
| Everything             | `~/.slick/slick.db` (override with `SLICK_HOME`) |
| Daemon address + token | `~/.slick/daemon.json`                           |
| Daemon log             | `~/.slick/daemon.log`                            |

Back it up by copying the file. Move it to another machine and it just works.

The daemon binds to `127.0.0.1` and requires a token (kept in `daemon.json`,
mode 600). The desktop app trades that token for an `HttpOnly` cookie on first
load; scripts use `Authorization: Bearer`. The `Host` header is pinned to
localhost so a web page you have open cannot reach it.

## Layout

```
packages/core      storage + domain rules (channels, categories, threads, messages, agents)
packages/server    the daemon: REST, live SSE stream, hosts the web UI
packages/cli       the `slick` command
apps/web           the UI — plain ES modules, no build step
apps/desktop       the Electron shell around it
scripts            demo seeding, UI smoke test, screenshots
```

`@slick/core` holds every rule. The CLI calls it directly; the server exposes
it over HTTP; the app calls the server. There is exactly one implementation of
"what happens when you post a message", so the two front ends cannot drift.

## Tests

```bash
npm test              # 87 tests: core, HTTP API, and the CLI end to end
npm run smoke:ui      # loads the real UI in Electron and drives it
npm run shots         # screenshots of the UI into $SLICK_HOME/shots
```

The CLI suite spawns the real binary for every assertion, so agent resume is
tested the way it is actually used: across separate processes.

In an environment that is already sandboxed (CI, containers), Chromium cannot
nest its own sandbox:

```bash
SMOKE_NO_SANDBOX=1 npm run smoke:ui
```

## What is not here yet

- Mobile. The API and UI are ready for it — the web UI is responsive and the
  daemon takes `--host 0.0.0.0` — but there is no native client.
- File uploads, reactions, and multi-user anything. This is deliberately a
  single-user workspace.
