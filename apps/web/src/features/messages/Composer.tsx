/**
 * The box you type in — rendered twice, under the channel and under the
 * thread — with the two menus that pop up over it and the line only you see.
 *
 * The textarea is uncontrolled: what it holds is read off the node when it
 * matters (a submit, a menu sync), so nothing about the app's state has to be
 * kept in step with every keystroke.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';

import { runSlashCommand } from '../../app/actions.ts';
import {
  COMMAND_LINE_RE,
  commandMatches,
  commandNote,
  findCommand,
  insertCommand,
  isUnavailable,
  type CommandEntry,
} from './commands.ts';
import { renderText } from '../../shared/lib/format.ts';
import { findMention, insertMention, mentionMatches, type MentionAnchor } from './mentions.ts';
import type { AgentSuggestion } from './sessions.ts';
import type { EphemeralOutput } from '../../app/types.ts';

const SEND_ICON = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M2 10l16-7-7 16-2-6-7-3z" />
  </svg>
);

export interface ComposerProps {
  /** Which of the two this is; every id on it follows. */
  where: 'main' | 'thread';
  disabled?: boolean;
  placeholder: string;
  onSubmit: (text: string) => Promise<void>;
  /** Known agents for the `@` menu, asked for when the menu opens. */
  suggestions: () => readonly AgentSuggestion[];
  /** The agent's commands as currently known, and how to fetch them the first time. */
  commands: () => readonly CommandEntry[];
  loadCommands: () => Promise<void>;
}

const IDS = {
  main: {
    form: 'composer',
    input: 'composer-input',
    button: 'btn-send',
    mentions: 'mention-menu-main',
    commands: 'command-menu-main',
    output: 'composer-out',
  },
  thread: {
    form: 'thread-composer',
    input: 'thread-input',
    button: 'btn-thread-send',
    mentions: 'mention-menu-thread',
    commands: 'command-menu-thread',
    output: 'thread-composer-out',
  },
} as const;

interface MentionMenuState {
  anchor: MentionAnchor;
  items: AgentSuggestion[];
  index: number;
}

interface CommandMenuState {
  items: CommandEntry[];
  index: number;
  loading: boolean;
}

/** Grow a composer with its content instead of scrolling a one-line box. */
function autosize(node: HTMLTextAreaElement, max = 320): void {
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, max)}px`;
}

export function Composer({
  where,
  disabled = false,
  placeholder,
  onSubmit,
  suggestions,
  commands,
  loadCommands,
}: ComposerProps) {
  const ids = IDS[where];
  const input = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [empty, setEmpty] = useState(true);
  const [output, setOutput] = useState<EphemeralOutput | null>(null);
  const [mentions, setMentions] = useState<MentionMenuState | null>(null);
  const [menu, setMenu] = useState<CommandMenuState | null>(null);
  /** Which opening of the command menu a fetch belongs to, so a late answer redraws nothing. */
  const loadToken = useRef(0);
  const menuOpen = useRef(false);

  useEffect(() => {
    if (input.current) autosize(input.current);
  }, []);

  const closeMentions = () => setMentions(null);
  const closeCommands = () => {
    menuOpen.current = false;
    loadToken.current += 1;
    setMenu(null);
  };

  /** Put `value` in the box with the caret at `caret`, and tell the button. */
  const write = (value: string, caret: number) => {
    const node = input.current;
    if (!node) return;
    node.value = value;
    node.setSelectionRange(caret, caret);
    setEmpty(value.trim().length === 0);
    autosize(node);
    node.focus();
  };

  function syncCommands(): void {
    const node = input.current;
    if (!node) return;
    const found = findCommand(node.value, node.selectionStart);
    if (!found) {
      if (menuOpen.current) closeCommands();
      return;
    }
    if (!menuOpen.current) {
      menuOpen.current = true;
      const token = ++loadToken.current;
      setMenu({ items: [], index: 0, loading: true });
      loadCommands().then(
        () => {
          if (menuOpen.current && token === loadToken.current) syncCommands();
        },
        () => {
          if (menuOpen.current && token === loadToken.current) syncCommands();
        }
      );
      // The list as it stands now, loading or not: an agent already asked has
      // its menu at once.
      setMenu({ items: commandMatches(commands(), found.query), index: 0, loading: true });
      return;
    }
    setMenu({ items: commandMatches(commands(), found.query), index: 0, loading: false });
  }

  function syncMentions(): void {
    const node = input.current;
    if (!node) return;
    const found = findMention(node.value, node.selectionStart);
    if (!found) {
      closeMentions();
      return;
    }
    setMentions({ anchor: found, items: mentionMatches(suggestions(), found.query), index: 0 });
  }

  const sync = () => {
    const node = input.current;
    if (!node) return;
    setEmpty(node.value.trim().length === 0);
    autosize(node);
    syncMentions();
    syncCommands();
  };

  const chooseMention = (i: number) => {
    const node = input.current;
    if (!node || !mentions) return;
    const item = mentions.items[i];
    if (!item) return;
    const next = insertMention(node.value, mentions.anchor, item.id);
    closeMentions();
    write(next.value, next.caret);
  };

  const chooseCommand = (i: number) => {
    const node = input.current;
    if (!node || !menu) return;
    const item = menu.items[i];
    if (!item || isUnavailable(item)) return;
    const next = insertCommand(node.value, item.name);
    closeCommands();
    write(next.value, next.caret);
  };

  /** Whichever menu is open gets the key first; only one ever is. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions && mentions.items.length > 0) {
      if (
        handleMenuKey(
          event,
          mentions.index,
          mentions.items.length,
          (index) => setMentions({ ...mentions, index }),
          chooseMention,
          closeMentions
        )
      )
        return;
    }
    if (menu && (menu.items.length > 0 || menu.loading)) {
      if (
        handleMenuKey(
          event,
          menu.index,
          menu.items.length,
          (index) => setMenu({ ...menu, index }),
          chooseCommand,
          closeCommands
        )
      )
        return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      form.current?.requestSubmit();
    }
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const node = input.current;
    if (!node) return;
    const text = node.value;
    if (!text.trim()) return;
    closeMentions();
    closeCommands();
    write('', 0);
    // A line that is only a slash command is a question for the agent's
    // console, not a message for the channel. It leaves nothing behind.
    if (COMMAND_LINE_RE.test(text.trim())) {
      await runSlashCommand(text.trim(), setOutput);
      return;
    }
    await onSubmit(text);
  };

  const onBlur = () => {
    setTimeout(() => {
      closeMentions();
      closeCommands();
    }, 120);
  };

  const outputNode = output ? (
    <div className={`composer__out${output.kind ? ` is-${output.kind}` : ''}`} id={ids.output}>
      <div className="composer__out-head">
        <span className="composer__out-title">{output.title}</span>
        <button
          className="composer__out-close"
          type="button"
          aria-label="Dismiss"
          onClick={() => setOutput(null)}
        >
          ×
        </button>
      </div>
      {output.body ? (
        <div className="composer__out-body" dangerouslySetInnerHTML={{ __html: renderText(output.body) }} />
      ) : null}
    </div>
  ) : (
    <div className="composer__out" id={ids.output} hidden />
  );

  const commandMenu = (
    <ul
      className="command-menu"
      id={ids.commands}
      hidden={!menu || (!menu.loading && menu.items.length === 0)}
    >
      {menu?.loading && menu.items.length === 0 ? (
        <li className="is-loading" role="status">
          Loading commands…
        </li>
      ) : null}
      {menu?.items.map((item, i) => {
        const unavailable = isUnavailable(item);
        const note = commandNote(item);
        return (
          <li
            key={item.name}
            className={`${i === menu.index ? 'is-sel' : ''}${unavailable ? ' is-off' : ''}`}
            role="option"
            aria-selected={i === menu.index}
            aria-disabled={unavailable ? 'true' : undefined}
            onMouseDown={(event) => {
              event.preventDefault();
              chooseCommand(i);
            }}
            onMouseMove={() => {
              if (menu.index !== i) setMenu({ ...menu, index: i });
            }}
          >
            <span className="what">{`/${item.name}${item.args ? ` ${item.args}` : ''}`}</span>
            <span className="where">{note || item.summary || ''}</span>
          </li>
        );
      })}
    </ul>
  );

  const mentionMenu = (
    <ul className="mention-menu" id={ids.mentions} hidden={!mentions || mentions.items.length === 0}>
      {mentions?.items.map((item, i) => (
        <li
          key={item.id}
          className={i === mentions.index ? 'is-sel' : ''}
          onMouseDown={(event) => {
            event.preventDefault();
            chooseMention(i);
          }}
          onMouseMove={() => {
            if (mentions.index !== i) setMentions({ ...mentions, index: i });
          }}
        >
          <span className="what">@{item.id}</span>
          {item.hint ? <span className="where">{item.hint}</span> : null}
        </li>
      ))}
    </ul>
  );

  const textarea = (
    <textarea
      id={ids.input}
      ref={input}
      className="composer__input"
      rows={where === 'main' ? 1 : 3}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={where === 'main' ? true : undefined}
      disabled={disabled}
      onInput={sync}
      onClick={sync}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );

  const button = (
    <button
      type="submit"
      className="send-btn"
      id={ids.button}
      disabled={empty || disabled}
      aria-label={where === 'main' ? 'Send' : 'Send reply'}
    >
      {SEND_ICON}
    </button>
  );

  return (
    <form
      className={`composer${where === 'thread' ? ' composer--thread' : ''}`}
      id={ids.form}
      ref={form}
      onSubmit={(e) => void submit(e)}
    >
      <div className="composer__box">
        {outputNode}
        {commandMenu}
        {mentionMenu}
        {textarea}
        {where === 'main' ? (
          <div className="composer__row">
            <span className="composer__hint">
              <b>Enter</b> to send · <b>Shift+Enter</b> for a new line
            </span>
            {button}
          </div>
        ) : (
          button
        )}
      </div>
    </form>
  );
}

/** Arrow keys move, Enter or Tab picks, Escape closes. Returns whether the key was consumed. */
function handleMenuKey(
  event: KeyboardEvent<HTMLTextAreaElement>,
  index: number,
  count: number,
  move: (index: number) => void,
  choose: (index: number) => void,
  close: () => void
): boolean {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(Math.min(index + 1, Math.max(count - 1, 0)));
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(Math.max(index - 1, 0));
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    choose(index);
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return true;
  }
  return false;
}
