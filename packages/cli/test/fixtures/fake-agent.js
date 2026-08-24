#!/usr/bin/env node
/**
 * Stands in for `claude -p … --output-format json` in tests: same calling
 * convention, but deterministic and free. Echoes the last line of the
 * prompt (the message being answered) and reports whether it was resumed,
 * so tests can assert on both the reply text and session continuity.
 */

import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);

// `serve` asks the binary what it can run before it asks it anything else.
// `FAKE_AGENT_NO_MODELS` plays the agent that has never heard of the flag —
// the `claude` CLI today — which must cost the watcher nothing but a probe.
if (args.includes('--list-models')) {
  if (process.env.FAKE_AGENT_MODELS_LOG) appendFileSync(process.env.FAKE_AGENT_MODELS_LOG, 'asked\n');
  if (process.env.FAKE_AGENT_NO_MODELS) {
    process.stderr.write('unknown flag --list-models\n');
    process.exit(2);
  }
  process.stdout.write(
    JSON.stringify({
      models: [
        { id: 'north::big', label: 'big', group: 'north' },
        { id: 'north::small', label: 'small', group: 'north' },
        { id: 'south::quick', label: 'quick', group: 'south' },
      ],
    })
  );
  process.exit(0);
}
const promptIndex = args.indexOf('-p');
const prompt = promptIndex === -1 ? '' : args[promptIndex + 1];
const resumeIndex = args.indexOf('--resume');
const resumeId = resumeIndex === -1 ? null : args[resumeIndex + 1];
const resumed = resumeId !== null;
const lastLine = prompt.trim().split('\n').at(-1);

// A resumed call continues the conversation it was handed, so it reports that
// id back — which is how a test can tell *which* session answered, not merely
// that some session did. `FAKE_AGENT_SESSION_ID` names the new one.
const sessionId = resumeId ?? process.env.FAKE_AGENT_SESSION_ID ?? 'fake-session-1';

if (process.env.FAKE_AGENT_FAIL) {
  process.stdout.write(JSON.stringify({ is_error: true, result: 'boom', session_id: 'fake-session-1' }));
  process.exit(0);
}

// An answer too long for one message. Posting it whole is refused for length,
// which `serve` used to read as a failed call — so the answer cost three runs
// of the model and was then dropped. It must arrive as several messages.
if (process.env.FAKE_AGENT_LONG) {
  const wanted = Number(process.env.FAKE_AGENT_LONG);
  const lines = [];
  let size = 0;
  for (let i = 0; size < wanted; i++) {
    lines.push(`line ${i}: ${'.'.repeat(40)}`);
    size += lines.at(-1).length + 1;
  }
  process.stdout.write(JSON.stringify({ is_error: false, result: lines.join('\n'), session_id: sessionId }));
  process.exit(0);
}

// The real failure that prompted the retry rework: a resumed transcript that
// has outgrown the request limit fails every time, while a fresh one is fine.
if (process.env.FAKE_AGENT_OVERSIZED_RESUME && resumed) {
  process.stdout.write(
    JSON.stringify({
      is_error: true,
      result: "Request too large for the API's 32MB request limit: this conversation cannot continue as is.",
      session_id: 'fake-session-1',
    })
  );
  process.exit(0);
}

// For tests that care about what we were *handed* — which half of the call a
// given instruction rode in — rather than about the answer. Last, so that a
// retirement round dumps the fresh call rather than the doomed resumed one.
// It goes to a file rather than into the reply: echoing a prompt back into the
// channel would put it in the next call's transcript, where it would fool
// every assertion about what the prompt does and does not contain.
if (process.env.FAKE_AGENT_DUMP) {
  const systemIndex = args.indexOf('--append-system-prompt');
  const modelIndex = args.indexOf('--model');
  const effortIndex = args.indexOf('--effort');
  writeFileSync(
    process.env.FAKE_AGENT_DUMP,
    JSON.stringify({
      prompt,
      system: systemIndex === -1 ? null : args[systemIndex + 1],
      model: modelIndex === -1 ? null : args[modelIndex + 1],
      effort: effortIndex === -1 ? null : args[effortIndex + 1],
      resumed,
      resumeId,
    })
  );
  process.stdout.write(
    JSON.stringify({ is_error: false, result: `dumped(resumed=${resumed})`, session_id: sessionId })
  );
  process.exit(0);
}

// The model the binary says it actually answered with. Real agents resolve
// aliases, fall back, or ignore `--model` outright, so what they report is not
// always what they were asked for — `FAKE_AGENT_REPORTS_MODEL` plays that.
const reply = {
  is_error: false,
  result: `echo(resumed=${resumed}): ${lastLine}`,
  session_id: sessionId,
};
if (process.env.FAKE_AGENT_REPORTS_MODEL) reply.model = process.env.FAKE_AGENT_REPORTS_MODEL;

process.stdout.write(JSON.stringify(reply));
