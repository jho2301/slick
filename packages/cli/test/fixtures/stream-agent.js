#!/usr/bin/env node
/**
 * An agent that narrates. Where `fake-agent.js` prints one JSON document at
 * the end, this one prints a frame per line as it goes — a thought, a tool
 * starting and finishing, the answer a piece at a time — and only then the
 * line that carries the whole answer and the session id.
 *
 * It narrates whether or not it was asked to. That is the point of the flag:
 * `--stream` proves the adapter's own argument group reached the binary, while
 * an adapter with no stream block still gets a perfectly readable final line
 * out of exactly the same output.
 *
 * The frames are deliberately spread over a couple of hundred milliseconds,
 * because a run that prints everything in one tick can never show that the
 * watcher coalesces rather than posting per token.
 */

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const at = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};

const prompt = at('-p') ?? '';
const resumeId = at('--resume');
const session = resumeId ?? process.env.STREAM_AGENT_SESSION ?? 'stream-session-1';
const answer = `streamed(resumed=${Boolean(resumeId)}): ${prompt.trim().split('\n').at(-1)}`;

// What the call looked like from in here, for a test that cares which flags
// arrived rather than what came back.
if (process.env.STREAM_AGENT_DUMP) {
  writeFileSync(process.env.STREAM_AGENT_DUMP, JSON.stringify({ args, prompt, resumeId }));
}

/** The answer, in the four pieces a model would have written it in. */
const size = Math.ceil(answer.length / 4);
const pieces = [];
for (let cut = 0; cut < answer.length; cut += size) pieces.push(answer.slice(cut, cut + size));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A console prints for people too. Neither of these is a frame this adapter
// knows how to read, and neither is an error: one is not JSON at all, the
// other is JSON with nothing in it we asked for.
process.stdout.write('stream-agent: warming up\n');
process.stdout.write(`${JSON.stringify({ usage: { input: 12, output: 0 } })}\n`);

const frames = [
  { delta: { thinking: 'Working out what was asked' } },
  { tool: { name: 'Reading the thread', status: 'in_progress' } },
  { tool: { name: 'Reading the thread', status: 'complete' } },
  ...pieces.map((text) => ({ delta: { text } })),
];

// A run that gets stuck. It opens a tool and then never comes back, which is
// what a real one looks like from the outside when it runs out of time: the
// last thing anybody heard was a step starting, and the only way to say so
// honestly is to still be inside it when the watcher gives up.
if (process.env.STREAM_AGENT_HANG) {
  for (const frame of frames.slice(0, 2)) {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
    await sleep(40);
  }
  await sleep(60_000);
}

for (const frame of frames) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
  await sleep(40);
}

process.stdout.write(`${JSON.stringify({ answer, session_id: session })}\n`);
