import { defineConfig, type TestProjectConfiguration } from 'vitest/config';

/**
 * One runner for every package. Each project keeps its own environment: the
 * Node packages run as plain processes (forks, like `node --test` did), the
 * web app renders into jsdom.
 *
 * The suites spawn the real CLI and daemon and wait on real HTTP, so the
 * timeouts are far above Vitest's five-second default. `--no-warnings`
 * silences Node 22's `node:sqlite` ExperimentalWarning in every worker; it has
 * to be set per project, because worker options are not inherited from the
 * root when projects are in use.
 */
const nodeProject = (name: string, dir: string): TestProjectConfiguration => ({
  test: {
    name,
    environment: 'node',
    include: [`${dir}/test/**/*.test.ts`],
    pool: 'forks',
    execArgv: ['--no-warnings'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

/**
 * The browser app, in jsdom. What jsdom lacks — `<dialog>`, `matchMedia`,
 * `EventSource`, `CSS.escape` — the setup file stubs, so a component test
 * exercises the same code the page runs.
 */
const webProject: TestProjectConfiguration = {
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['apps/web/test/**/*.test.{ts,tsx}'],
    setupFiles: ['apps/web/test/setup.ts'],
    testTimeout: 20_000,
  },
};

export default defineConfig({
  test: {
    projects: [
      nodeProject('core', 'packages/core'),
      nodeProject('server', 'packages/server'),
      nodeProject('cli', 'packages/cli'),
      webProject,
    ],
  },
});
