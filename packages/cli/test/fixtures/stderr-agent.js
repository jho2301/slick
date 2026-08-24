#!/usr/bin/env node
/**
 * An agent that keeps stdout for the answer and says everything else on
 * stderr — `hermes chat -q`'s shape, and the reason a reply field can be
 * found by pattern instead of by JSON key. It also reports the model and
 * provider it was handed, so a test can see a `provider::model` id arrive
 * split across two flags.
 */

const args = process.argv.slice(2);
const at = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};

const resumeId = at('--resume');
const session = resumeId ?? process.env.STDERR_AGENT_SESSION ?? 'sess-1';
const prompt = at('-q') ?? '';

// Quiet mode still narrates a resume — on stderr, where it cannot be mistaken
// for the answer.
if (resumeId) process.stderr.write(`↻ Resumed session ${session} (2 user messages, 6 total messages)\n`);

if (process.env.STDERR_AGENT_FAIL) {
  process.stderr.write('Error: provider unreachable\n');
  process.stderr.write(`\nsession_id: ${session}\n`);
  process.exit(1);
}

const answer = [
  `answered(resumed=${Boolean(resumeId)},`,
  `model=${at('-m') ?? '-'},`,
  `provider=${at('--provider') ?? '-'}):`,
  prompt.trim().split('\n').at(-1),
].join(' ');

process.stdout.write(`${answer}\n`);
process.stderr.write(`\nsession_id: ${session}\n`);
