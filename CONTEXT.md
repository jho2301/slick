# Slick — the vocabulary

What the words mean, one meaning each. Where a word had two, the one the code
uses now is marked, and the other is named so it is not reintroduced.

## The workspace

- **Workspace** — one person's Slack-shaped place: channels, threads, messages,
  and the agents that take part. Everything lives in one SQLite file. _Not_ a
  read scope; see **surface** and **scope**.
- **Home** — the directory the workspace lives in (`SLICK_HOME`, `~/.slick` by
  default). Holds the database, the daemon's address, its log, its token, the
  adapters, and the locks. Distinct from a Hermes profile's `HERMES_HOME` and
  from a session's **default channel**.
- **User** — the one human of the workspace, with an id and a name.
- **Author** — who said or did something: an id, a **kind** (`human`, `agent`
  or `system`) and, on a message, a label to show. One type, `Author`, on
  messages and on events alike; "actor" is the same thing and is not used for
  anything else.
- **Daemon** — the long-lived local server the app and any remote tool talk
  to: REST, the live stream, the built web UI. Started by `slick daemon start`
  or `slick app`. "slickd" is the daemon's process name, not a second thing.

## Channels

- **Channel** — a place messages are posted, addressed by **slug** when a
  human types it (`#general`) and by id when a machine stores it. A
  **reference** ("ref") is whichever of the two a lookup was handed.
- **Slug** — the typed handle of a channel or category: lowercase letters,
  digits, `-`, `_`, `.`.
- **Category** — a section of the rail that groups channels. Pure grouping: it
  owns no messages and holds no rules, and a channel is in at most one. It has
  a position and a **fold** state, both kept in the workspace, not the browser.
- **Uncategorised bucket** — the "Channels" section at the bottom of the rail,
  where every channel with no category sits ("loose" channels in code). It
  hides when empty and reappears for as long as a channel is being dragged,
  because it is the only way out of a category.
- **Archived channel** — hidden from lists and closed to posting until it is
  unarchived; nothing in it is lost.

## Messages

- **Message** — text in a channel, with an author, mentions, optional
  **metadata** the author attached, and a seq. Deleting one usually leaves a
  **tombstone** so its replies keep their anchor; a hard delete removes it.
- **Thread** — a root message and its replies. One level only: replying to a
  reply targets the root. A thread's id is its root's id. In `serve`, one
  thread is one conversation with the agent.
- **Reply** — a message inside a thread. Not to be confused with an adapter's
  reply block, which is called the **answer** here.
- **Mention** — an `@name` in message text. A served agent answers when it is
  mentioned; the composer offers only the agents that answer.
- **Metadata bookkeeping** — the underscore-prefixed keys Slick itself writes
  into a message's metadata: which model answered (`_model`), how hard it
  thought (`_effort`), its **thinking trace** (`_think`), its declared
  **response sections** (`_response`). Shown properly, never dumped raw.
- **Response sections** — the four labels an agent's answer may be cut along:
  Answer, Reasoning summary, Process, Assumptions. The answer is the body; the
  other three are collapsible cards under it. A reply with no label is left
  exactly as written.
- **Grouped message** — a message drawn tucked under the one above it, with no
  header: same author, within five minutes, same day, and the same badge —
  because a grouped row has nowhere to show its own model.

## Agents

- **Agent** — an AI participant, named by an agent id. Anything a person can
  do, an agent can do. Not the binary `serve` spawns (that is the
  **adapter**'s command) and not Hermes the product.
- **Agent session** — the resume mechanism: a row keyed by a **history key**
  that remembers a **cursor**, the agent's **state**, and a **default
  channel**. Two kinds share the table: **served agents**, which a watcher
  answers for, and **automations**, which only post. Only the first kind is
  **callable** — offered in the mention picker and the rail.
- **History key** — the durable pointer an agent carries between runs
  (`slk_h1_…`). Stamped on every message the session posts.
- **Session name** — an optional, per-agent label a session can be found by
  when the key is lost.
- **Cursor** — how far the session has read in the event log. "Done", not
  "seen": `pull` moves it, `resume` and `peek` never do, `ack` moves it by
  hand.
- **Resume** — read everything since the cursor (**missed**), the recent
  channel messages (**context**), the saved **state**, and how much is waiting
  (**pending**), without moving anything. **Pull** reads and moves the cursor.
- **State (agent memory)** — the agent's own JSON, kept verbatim between runs.
  Underscore-prefixed keys in it are Slick's **serve bookkeeping**: the model
  and effort to call with, the adapter last used, the cached model choices, and
  the per-thread **child sessions**.
- **Child session** — the agent binary's own conversation for one thread,
  resumed on every message in that thread. Distinct from the Slick session it
  belongs to.
- **Watcher** — a running `slick agent serve`: it watches one session, spawns
  the agent for every message that addresses it, narrates the answer as it
  arrives, and posts the result into the thread. Holds the session's lock so
  no second watcher consumes the same messages.
- **Adapter** — the calling convention for an agent binary: how the prompt,
  the resumed conversation, the model and the effort are passed, and where in
  the output the answer sits. Two are built in (`claude`, `plain`); others are
  JSON manifests under the home. The Hermes **gateway plugin** is a different
  integration with the same word in its filename, and is called the plugin.
- **Model** — the name of what answered, as the agent reports it. Identity is
  the untrimmed name; only the badge shortens a weight-file name.
- **Effort** — how hard an agent thinks, in the agent's own vocabulary.
- **Model choices** — the models a session's agent said it can run, shown by
  the **model picker** (`/model`) to set that one session's model. Not the
  Hermes **catalog**.

## Live signals

- **Event** — one row in the workspace's log, with a **seq**. Every change,
  whoever made it, is an event, and the **stream** carries them to whoever is
  listening.
- **Typing** — an agent has started on an answer. A change, not a state: it is
  switched on and off, and a backstop timer switches it off if the agent died.
- **Thinking signal** — the steps an agent announces while it works, sent as
  patches. **Thinking trace** is the folded result stored on the finished
  message; the **thinking box** is the disclosure that draws either one.
- **Delta** — a fragment of an answer in flight, never written down. It is
  the one frame with no seq.
- **Streaming reply** — an answer arriving a token at a time, drawn in the
  shape of the message it is about to become, in place of the typing
  indicator. Torn down when the message lands, when the producer says it is
  done, or when the backstop gives up. ("Draft" is not used for this.)
- **Snapshot** — what a tab that opened mid-answer asks for: who is typing
  now, and what they have shown of their thinking so far.

## Hermes

- **Profile** — a whole Hermes installation's configuration: which provider
  and model it hands out by default, and how hard it thinks. The **Hermes
  panel** edits one profile's defaults; it changes no running conversation.
- **Catalog** — the providers and models a profile could be set to, as Hermes
  reports them. A configured value the catalog cannot see is offered anyway,
  marked **unlisted**, so a save never silently overwrites it.
- **Provider** — who serves a model. In a session's model id it is the part
  before `::`; in a profile it is its own field, saved together with the model.
- **Pending selection** — what the panel's selects show before it is saved,
  as opposed to what the profile is **saved** on. The two differ only while
  someone is mid-decision, which is when Save has something to do.
- **Account limits** — what the account behind a profile's provider has left:
  the five-hour and weekly **usage windows**, and the **banked resets** (drawn
  as "reset tickets"). Shown in a rail section of their own, under the Hermes
  panel, only for a provider that reports any.
- **Gateway plugin** — the Hermes platform plugin that puts Hermes in a Slick
  channel by tailing the stream and answering over the API.

## The app

- **Rail** — the left column: the workspace, the channel sections, the Hermes
  panel and its limits, the connection light. ("Sidebar" is not used.)
- **Timeline** — the middle column's scroll of a channel's messages.
- **Thread pane** — the right column showing one thread, with its own
  composer and a resizable width.
- **Surface** — which of the two a message is drawn on, `timeline` or
  `thread`. A thread root is on both at once; the copies share their state but
  not their ids. ("Scope" is not used for this.)
- **Composer** — the box you type in, under the timeline and under the
  thread. It offers a **mention menu** and, for an agent's own slash commands,
  a **command menu**; a slash command's answer is **ephemeral** — drawn above
  the composer for the person who asked, never posted.
- **Layer** — on a narrow viewport the app is a stack: the rail, then the
  channel over it, then the thread over that; each layer puts an entry behind
  itself so the back button peels one off.
- **Palette** — the ⌘K box: jump to a channel, or search messages.
- **Scope** (read scope) — for an agent's reads only: `workspace` for every
  channel, `session` for its default channel.
- **Unread** — messages that landed in a channel while it was not on screen.
