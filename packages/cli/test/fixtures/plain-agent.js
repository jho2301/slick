#!/usr/bin/env node
/**
 * The other shape of agent: a prompt on stdin, an answer on stdout, no JSON
 * and no conversation to resume. `serve --adapter plain` has to be able to
 * talk to something this plain — it is what a shell script looks like.
 */

import { readFileSync } from 'node:fs';

const prompt = readFileSync(0, 'utf8');
process.stdout.write(`plain saw: ${prompt.trim().split('\n').at(-1)}\n`);
