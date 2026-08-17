#!/usr/bin/env node
/**
 * Stands in for `claude -p … --output-format json` in tests: same calling
 * convention, but deterministic and free. Echoes the last line of the
 * prompt (the message being answered) and reports whether it was resumed,
 * so tests can assert on both the reply text and session continuity.
 */

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');
const prompt = promptIndex === -1 ? '' : args[promptIndex + 1];
const resumed = args.includes('--resume');
const lastLine = prompt.trim().split('\n').at(-1);

if (process.env.FAKE_AGENT_FAIL) {
  process.stdout.write(JSON.stringify({ is_error: true, result: 'boom', session_id: 'fake-session-1' }));
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
  writeFileSync(
    process.env.FAKE_AGENT_DUMP,
    JSON.stringify({ prompt, system: systemIndex === -1 ? null : args[systemIndex + 1], resumed })
  );
  process.stdout.write(
    JSON.stringify({ is_error: false, result: `dumped(resumed=${resumed})`, session_id: 'fake-session-1' })
  );
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    is_error: false,
    result: `echo(resumed=${resumed}): ${lastLine}`,
    session_id: 'fake-session-1',
  })
);
