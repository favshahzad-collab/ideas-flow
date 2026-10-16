import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Two suites, because they need different worlds.
 *
 * `unit` is every pure function: mappers, filters, formatters, the workflow
 * compiler. Node is the honest environment for those - if one of them ever
 * needs a `window`, that is a fact worth being told about rather than one
 * papered over by running everything in a browser shim.
 *
 * `dom` is components, hooks and the two utilities that genuinely drive the
 * DOM. It pays for jsdom and gets `cleanup` between tests.
 *
 * A DOM test with no JSX in it is named `*.dom.test.ts` so the split stays
 * legible from the filename alone.
 */
const shared = {
  globals: false,
  restoreMocks: true,
  // `restoreMocks` restores spies, but it does NOT clear the call history of a
  // `vi.fn()` created inside a `vi.mock` factory — and almost every component
  // test mocks a service module that way. Without this, "was approveDocument
  // called?" answers for the whole file rather than for the test asking.
  clearMocks: true,
} as const

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          ...shared,
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'src/**/*.dom.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          ...shared,
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx', 'src/**/*.dom.test.ts'],
          exclude: ['**/node_modules/**'],
          setupFiles: ['src/test/setup.ts'],
          /*
           * Well above what these need, deliberately.
           *
           * A jsdom interaction test pays an act() flush and a React render
           * per keystroke, so typing an email address into a form costs about
           * a second of honest work - measured, not guessed: the tests in
           * LoginPage that type run 0.99-1.4s idle, and the ones that only
           * click run 0.14s. Against vitest's 5s default that is four times
           * headroom, which sounds ample and is not: running this suite beside
           * the backend integration suite took two of them past the budget and
           * reported a green screen as broken.
           *
           * Fifteen seconds still fails a genuinely hung test in reasonable
           * time, and it stops a loaded machine from being reported as a
           * defect. The `unit` project keeps the 5s default on purpose - a
           * pure function that runs that long IS the bug.
           */
          testTimeout: 15_000,
          // Threads, not the default forks. Every one of these files builds a
          // fresh jsdom and re-imports React, Testing Library and jest-dom;
          // with seven forks competing for that, workers were timing out
          // before they had finished booting and whole files were reported as
          // failures having never run a test. Threads start cheaply enough
          // that the same suite runs to completion.
          pool: 'threads',
        },
      },
    ],
  },
})
