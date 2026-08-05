#!/usr/bin/env node
/**
 * `slick` — the command line for your workspace.
 *
 * Both a human tool and the agent API: everything a person can do here, an
 * agent can do with `--json`.
 */

// node:sqlite is behind an experimental flag; the warning would corrupt piped
// output and alarm people for no reason.
const emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(data.message ?? '')) {
    return false;
  }
  return emit.call(this, name, data, ...rest);
};

// `slick tail | head -3` should exit quietly rather than throw.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
});

const { main } = await import('../src/index.js');

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
