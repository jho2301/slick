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

Needs Node 22.18 or newer: the built-in `node:sqlite` means there is nothing
to compile, and every package is TypeScript that Node runs as it is. The web
UI is the one thing that gets built — `npm install` does it on the way in
(Vite, into `packages/server/public`), and `npm run build` redoes it after a
change.

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
answer everything) it spawns `claude -p` with the conversation as context and
replies into the thread with whatever came back.

**One thread is one conversation.** Each Slick thread gets its own `claude`
session, resumed across every message in that thread and no other, so two
threads running at once never read each other's turns — and the prompt for a
thread is that thread, not the whole channel. A mention that starts a new
thread starts a fresh session, with the recent channel messages as its
orientation. Because a thread's transcript is resumed for as long as the thread
lives, everything in the prompt is paid for again on every turn, so the agent's
saved `state` is re-sent only when it has actually changed. The 50 most
recently used threads are remembered (in `_serveThreads`); wake an older one
and it simply starts a new session. `--shared-session` goes back to a single
conversation shared by every thread.

**Changing the model, without stopping anything.** `--model` picks one when the
watcher starts, but a watcher can stay up for weeks — so the model is read out
of the session on every pass, and `slick agent model` writes it there:

```bash
slick agent model $KEY anthropic/claude-opus-4   # from the next message answered
slick agent model $KEY                           # what is it running?
slick agent model $KEY --clear                   # back to the --model default
```

The app does the same thing without a terminal: open **Agents** at the foot of
the sidebar and click the model under an agent's history key. Either way it is
one setting in one place — change it in the app and `slick agent model` reads
it back, and the rail updates itself when the CLI writes it.

**Where the list comes from.** Nobody remembers model names, so `serve` asks
the binary for them: `<cmd> --list-models`, answered with JSON, at most once
every six hours.

```json
{"models": [{"id": "copilot::gpt-5.4", "label": "gpt-5.4", "group": "copilot"}]}
```

The answer is cached on the session, which is what turns the app's text box
into a menu grouped by provider — and `slick agent model $KEY --list` prints
the same list. `id` is opaque to Slick: it hands it straight back as
`--model`, so an agent can encode whatever routing it needs in there. An agent
that has never heard of the flag (the `claude` CLI, today) simply keeps the
text box, and is not asked again for six hours.

Threads keep their conversations across the switch, and the setting is our
bookkeeping, not the agent's memory — it never shows up in a prompt.

**How hard it thinks** works the same way, and lands in the same place:

```bash
slick agent effort $KEY high      # from the next message answered
slick agent effort $KEY           # what is it set to?
slick agent effort $KEY --clear   # back to the agent's own default
```

There is no `--list` beside it, because the levels are the agent's own
vocabulary — `claude` takes five of them, Hermes eight — and a menu built here
would be a guess that goes stale. The level reaches the binary through the
adapter's `effort` argument group, so an agent that has no such flag simply
never gets asked. A reply then wears two badges side by side, the model and
the level it was thought at: `claude-opus-4` `xhigh`. Two rather than one
string, because they change independently and a thread is easier to scan for
the answers that were thought hard about when the level is its own column.
Grouping counts both: two consecutive replies that differ in either one keep
their own headers, since a grouped row shows no badge at all.

Which level a message says it was answered at follows the same rule as the
model, in reverse. `--effort` is a per-run override the agent applies to *that*
call, while a level recorded in the agent's own store can predate it — Hermes
writes a session's config once, when the session is created, and resuming
leaves it alone. So where Slick asked at all, what it asked for is what the
badge says; where it did not, the agent's own record fills in.

**You can see it thinking.** While a watcher has an agent working on a message,
the thread shows a typing indicator, and it disappears when the reply lands.
That signal is a *change* on the event stream, so a tab opened in the middle of
a long reply would have missed it — the app asks `GET /api/typing` on the way
up, and again whenever a dropped stream comes back, for who is working right
now. Two things keep a dead watcher from spinning forever: the answer only
counts as current for five minutes, and it only counts at all while that
session's `serve` lock is held by a live process. A watcher stopped with ctrl-c
writes its own "off" on the way out.

**And you can see what it is thinking about.** An agent that narrates — an
adapter with a `stream` block below, or the Hermes plugin further down — gets
a box above its answer while the answer is being written: one line saying what
it is working on right now, and under it the steps it has taken, each with a
mark saying whether it is running, finished or failed. The box stays on the
reply afterwards, so a thread read next week still shows the work rather than
only the conclusion.

It opens and closes on five rules, in that order, and they exist because the
box is a *detail* on somebody else's answer and the answer is the thing you
came for. It is **born collapsed** — a summary line and a chevron, nothing
else. **Your choice sticks while it streams**: open it and it stays open for
the whole run, however many steps arrive, because a box that reshuffled itself
under a reader mid-sentence would be unreadable. **Finishing collapses it**,
handing the space back to the answer that has just landed. **An error opens
it**, whatever you last chose, since the step that broke is the one thing in
there worth showing unasked — and that holds on a reload or a switch away and
back, not only at the moment it fails. **After that your choice is permanent**:
once the run is over, nothing moves the box again but you.

**Only agents that answer are offered.**
 A session that nothing watches — the
cron job that posts a morning digest owns a history key and a cursor exactly
like an agent does — is not something you can talk to, so the app keeps it out
of the sidebar and out of the `@mention` picker. What counts is the lock a
running `serve` holds plus the bookkeeping it leaves behind, so an agent stays
listed while its watcher restarts. `slick agent sessions` still shows every
session and a `serve` column saying which is which: `watching`, `idle` (served
before, nothing up right now), or `posts only`.

`--dry-run` shows you the prompt without calling or posting anything. Serving
does not hand the child process the ability to touch Slick itself — that stays
between you and whatever tool permissions you give it with `--permission-mode`
/ `--allowed-tools` / `--dangerously-skip-permissions`.

**Something other than `claude`.** `--cmd` names the binary; an **adapter**
says how to call it. The built-in default is the `claude` CLI's convention —
prompt in `-p`, conversation in `--resume`, answer in `{"result": …}` — and
anything that did not speak it needed a shim pretending to be `claude`. Write
the convention down instead, as `~/.slick/adapters/<name>.json`:

```json
{
  "label": "My runner",
  "cmd": "my-agent",
  "args": {
    "prompt": ["--ask", "{prompt}"],
    "resume": ["--thread", "{session}"],
    "model": ["--model", "{model}"]
  },
  "reply": { "format": "json", "text": "answer", "sessionId": "thread_id" },
  "maxMessageLength": 4000,
  "installHint": "brew install my-agent"
}
```

```bash
slick agent adapters                        # what this workspace can call
slick agent serve $KEY --adapter my-runner  # and how to call it
```

Every group is optional, and leaving one out is how you say the agent has no
such thing: no `model` group and Slick stops asking for a model, no `resume`
group and every message starts a fresh conversation with the thread as its
context. `"promptVia": "stdin"` hands the prompt over on stdin rather than in
an argument — which is what the other built-in, `plain`, does: prompt in, text
out, no JSON, so a shell script is a legitimate agent. A file named after a
built-in replaces it, so retuning `claude` for this workspace means writing
`claude.json` and nothing else.

**When one flag is not one value.** Two escapes, both optional, both a regex.
An argument group can `match` its value and spread the captures across several
flags; a reply field can be found by `pattern` in output that is not JSON.
Together that is enough for an agent whose answer is plain text on stdout and
whose session id arrives on stderr — which is `hermes chat -q`, and the whole
of `~/.slick/adapters/hermes.json`:

```json
{
  "label": "Hermes",
  "cmd": "/Users/you/.local/bin/hermes",
  "args": {
    "prompt": ["chat", "-q", "{prompt}"],
    "base": ["-Q", "--in", "/Users/you/code/slick", "--source", "slick", "--accept-hooks"],
    "resume": ["--resume", "{session}"],
    "model": {
      "match": "^(.+?)::(.+)$",
      "args": ["-m", "{2}", "--provider", "{1}"],
      "else": ["-m", "{value}"]
    }
  },
  "reply": {
    "format": "text",
    "sessionId": { "pattern": "session_id:\\s*(\\S+)", "from": "stderr" },
    "model": {
      "sqlite": "~/.hermes/state.db",
      "query": "SELECT model FROM sessions WHERE id = ?",
      "bind": "sessionId"
    }
  }
}
```

`{1}`, `{2}` are the captures, and a value that matches nothing leaves the
group out unless there is an `else`. A pattern field says which stream to read
(`from`: `stdout`, `stderr`, or both) and which capture it wants; give one to
`text` as well when the answer needs trimming before it is posted.

**What actually ran, and what it actually said.** `--model` and `--effort` are
requests: the agent resolves an alias, falls back to another provider, or was
switched by hand since. And a console is a display — an agent whose model
streams its reasoning prints that reasoning next to the answer, having already
written the clean final response to its own store. An agent that writes things
down can be asked: one read-only `SELECT`, bound to the session id just read
out of its output.

```json
"model": {
  "sqlite": "~/.hermes/state.db",
  "query": "SELECT model FROM sessions WHERE id = ?",
  "bind": "sessionId",
  "pattern": "([^/\\\\]+?)(?:\\.(?:gguf|safetensors))?$"
}
```

`text`, `model` and `effort` can be sourced this way; `sessionId` cannot, being
the key the others bind to. A `pattern` alongside trims what comes back, which
is how a local model stored as `C:\weights\Qwen3.8-27B.gguf` gets a badge that
says `Qwen3.8-27B`. A missing store, a missing row or a renamed table costs you
the badge and nothing else.

An answer read this way is the answer: the printed output is not used as a
fallback, because for the agents that need this at all it is precisely the
thing that cannot be trusted. A run that finishes without recording anything
is reported as a failed call rather than posted, and a resumed conversation is
checked against what the store said *before* the call — otherwise a run that
wrote nothing would answer the new message with the old reply.

What none of this will ever be is a program: one match, one row, no branching.
An agent that needs more than that needs a wrapper, and should have one.

**Watching it work, not just waiting for it.** An agent that prints as it goes
can have that printing shown, live, in the thread it is answering — the answer
filling in a word at a time, and above it a box saying which step the agent is
on. Slick reads none of that by guessing: a `stream` block says which fields of
the agent's own output carry it, in the same plucked-path style the `reply`
block uses.

```json
"stream": {
  "format": "jsonl",
  "args": ["--stream-json"],
  "text": "delta.text",
  "reasoning": "delta.thinking",
  "step": "tool.name",
  "stepStatus": "tool.status"
}
```

`format` is `jsonl` and nothing else so far — one JSON object per line on
stdout, which is what every streaming CLI already prints. `args` are the flags
that ask for the streaming in the first place, and they ride along whenever
there is a `stream` block to read the answer back with, rather than being a
second thing to remember to turn on. `text` is a piece of the answer,
`reasoning` is a piece of the model's own thinking, and `step` names a thing
the agent is doing — a tool, a search, a file — with `stepStatus` saying how
it went: `pending`, `in_progress`, `complete` or `error`. A step named twice is
that one step reporting back rather than a second row, so a word Slick does not
know reads as *started* the first time the step is seen and as *finished* the
time it comes back. Every path is optional, but a `stream` block that names no
`text`, no `reasoning` and no `step` is refused, because there would be nothing
to send on. So is an `args.stream` group with no `stream` block above it: the
flags would go out and nothing would read what came back.

A line that is not JSON is display noise — a banner, a progress bar, a
deprecation warning — and is skipped without comment; so is a frame whose
shape does not match the paths, which is how a heartbeat or a usage summary
gets ignored rather than flickering on screen as an empty delta. The answer
that is finally posted is still read out of the `reply` block, off the whole
of stdout, exactly as it is for an adapter that streams nothing: the streamed
text is a *preview* and never the message. What does outlive the call is the
step list, which is written down on the reply it belonged to, so a thread read
next week still says what the agent did to get there. An adapter with no
`stream` block is called, read and posted precisely as it was before there was
one.

**The agent's own slash commands.** Type `/` in the composer and you get the
*agent's* vocabulary, not Slick's — `/compress`, `/status`, `/reasoning`,
whatever that agent has. Slick keeps no list and invents no commands; it asks
the adapter:

```json
"commands": {
  "list": { "cmd": "…/python", "args": ["…/hermes-commands.py", "--list"] },
  "run":  { "cmd": "…/python", "args": ["…/hermes-commands.py", "{command}", "{args}"] }
}
```

`list` prints a JSON array of `{name, summary, args, aliases, where}` and fills
the menu; `run` is handed the name and the rest of the line and prints what the
command has to say. `where` is the agent's own verdict on each one — anything
other than `"run"` is still listed, greyed, with the reason, because a command
you cannot use here is a thing worth knowing about rather than a thing to hide.

**The answer is yours alone.** It comes back in the response to that one
request and is drawn above your composer until you dismiss it or type the next
thing. It is not a message, not an event, not a row in the log — nobody else
sees it and nothing keeps it, because a command's output is an answer to one
person's question. That is also why this runs in the daemon rather than the
watcher: none of it belongs in the conversation.

**A long answer arrives whole.** A message holds 40,000 characters, and an
answer past that used to be refused on the way in — which `serve` read as a
failed call, retried three times, and then dropped without a word. Now it is
posted as several messages, split between lines, and a code fence the split
lands inside is closed before the break and reopened after it so that neither
half renders as half a fence. An adapter can set `maxMessageLength` lower when
whatever is on the other end takes less than Slick does.

---

## Hermes, instead of a CLI per thread

`agent serve` spawns a process per thread. If you already run
[Hermes](https://github.com/NousResearch/hermes-agent) — one long-lived gateway that
sits in Slack, Telegram and the rest — `plugins/hermes/slick` is a platform
plugin that puts it in a Slick channel the same way. It tails `/api/stream` and
answers over the REST API, so there is no SDK and nothing to install beyond the
directory itself.

```bash
cp -R plugins/hermes/slick ~/.hermes/plugins/slick
hermes plugins enable slick-platform     # the name in plugin.yaml, not the directory
slick daemon start                       # the plugin needs something to talk to
```

Then give it a token and a channel. Either the environment:

```bash
export SLICK_TOKEN=...                   # the "token" field of ~/.slick/daemon.json
export SLICK_CHANNEL=general             # "*" for every channel, or a comma-separated list
hermes gateway restart
```

or `~/.hermes/config.yaml`, if you would rather not export anything:

```yaml
gateway:
  platforms:
    slick:
      enabled: true
      extra:
        url: http://127.0.0.1:4477
        channel: general
        token: <the token from ~/.slick/daemon.json>
```

Environment wins over `extra` when both are set, and `SLICK_HOME_CHANNEL` picks
where cron jobs (`deliver=slick`) land — it defaults to `SLICK_CHANNEL`.
Restart the gateway after either one; `hermes gateway status` should then list
Slick as connected. Hermes posts as an agent-kind author, so it never reads its
own replies back off the stream.

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
  agent start|sessions|resume|pull|post|reply|state|model|ack|watch|serve|end

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

To run without a token, create an empty `~/.slick/no-auth` file (or set
`SLICK_NO_AUTH=1`, or pass `slickd --no-auth`) and restart the daemon. The
loopback bind and the `Host` pin still apply, so only local processes can
connect — but any of them can, including a page in your browser. Delete the
file to turn auth back on.

## Layout

```
packages/core      storage + domain rules (channels, categories, threads, messages, agents)
packages/server    the daemon: REST, live SSE stream, serves the built web UI
packages/cli       the `slick` command
apps/web           the UI — React and jotai, built by Vite into packages/server/public
apps/desktop       the Electron shell around it
scripts            demo seeding, the dev server, UI smoke test, screenshots
```

Source directories follow the responsibilities inside each workspace:

```text
apps/web/src/
  app/                  application shell, shared state, navigation, and live events
  features/
    messages/           channels, threads, composer, message rendering, and helpers
    thinking/           thinking display and its UI state
    hermes/             profile, model, and usage UI with its helpers and store
    search/             search palette
  shared/
    api/                HTTP client
    lib/                formatting and clipboard helpers
    ui/                 modal and toast hosts and controls
  pwa/                  service worker, registration, and push subscriptions
  main.tsx              browser entry point
  styles.css            application stylesheet
apps/desktop/src/       Electron entry point
packages/server/src/
  http/                 routing, request helpers, and static file serving
  realtime/             SSE hub and web push delivery
  integrations/         agent commands and the Hermes TypeScript/Python bridge
  index.ts              server composition and public exports
  daemon.ts             daemon process lifecycle
```

Keep feature components and their helpers together. Application-wide orchestration
belongs in `app/`; reusable infrastructure belongs in `shared/`. Each workspace
keeps its tests in `test/` and executable shims in `bin/` where needed. Core domain
modules stay in `packages/core/src/`, and CLI handlers stay in
`packages/cli/src/commands/`. Package names and public exports remain the stable
boundaries between workspaces. Generated web assets live in
`packages/server/public/`; edit `apps/web/src/` or `apps/web/public/` instead.

`@slick/core` holds every rule. The CLI calls it directly; the server exposes
it over HTTP; the app calls the server. There is exactly one implementation of
"what happens when you post a message", so the two front ends cannot drift.
The wire types are `@slick/core`'s too — a message is one TypeScript type
whether the daemon is writing it or the browser is drawing it.

Everything is TypeScript. The Node packages run their `.ts` sources directly
(Node strips the types; there is no compile step and no loader), `tsc -b`
checks them, and `npm run check` runs the type check, the lint, the format
check and every test in one go. The vocabulary the code uses is written down in
[CONTEXT.md](./CONTEXT.md).

## Tests

```bash
npm test              # 534 tests: core, HTTP API, the CLI end to end, and the web app in jsdom
npm run smoke:ui      # builds the UI, loads it in Electron and drives it
npm run shots         # screenshots of the UI into $SLICK_HOME/shots
npm run dev           # the UI with hot reload, on a throwaway seeded workspace
```

The CLI suite spawns the real binary for every assertion, so agent resume is
tested the way it is actually used: across separate processes. The web suite
renders components into jsdom and drives the store the same way the live
stream does. `npm run dev` seeds a workspace under the system temp directory
and points Vite at a daemon of its own; set `SLICK_API_URL` to work against
the one you already have running.

The smoke test and the screenshots run against whatever `SLICK_HOME` says, so
point it at a throwaway directory seeded with `scripts/seed-demo.mjs` rather
than at your real workspace.

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
