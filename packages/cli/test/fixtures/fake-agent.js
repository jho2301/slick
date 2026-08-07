#!/usr/bin/env node
/**
 * Stands in for `claude -p … --output-format json` in tests: same calling
 * convention, but deterministic and free. Echoes the last line of the
 * prompt (the message being answered) and reports whether it was resumed,
 * so tests can assert on both the reply text and session continuity.
 */

const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');
const prompt = promptIndex === -1 ? '' : args[promptIndex + 1];
const resumed = args.includes('--resume');
const lastLine = prompt.trim().split('\n').at(-1);

if (process.env.FAKE_AGENT_FAIL) {
  process.stdout.write(JSON.stringify({ is_error: true, result: 'boom', session_id: 'fake-session-1' }));
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    is_error: false,
    result: `echo(resumed=${resumed}): ${lastLine}`,
    session_id: 'fake-session-1',
  })
);
