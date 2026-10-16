// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * The frontend has linted since the redesign; the backend never has. It is the
 * side holding the workflow rules, the permission checks and the audit writes,
 * so it is the side where a swallowed promise or an unchecked `any` costs
 * something real.
 *
 * Named  because this package is CommonJS - no "type": "module" - and
 * a flat config is ES module syntax either way.
 *
 * Named `.mjs` because this package is CommonJS - there is no
 * `"type": "module"` - while a flat config is ES module syntax either way.
 *
 * Type-aware rules are on. Without a type checker a linter cannot see a
 * floating promise, which in an Express handler means a response that never
 * arrives and an error that never surfaces — the single most useful thing it
 * can find here.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "storage/**",
      // Prisma writes this. Linting generated code reports on decisions
      // nobody in this repo made.
      "src/generated/**",
      // Plain Node on purpose: it runs on `postinstall`, which can be an
      // install with no TypeScript tooling in it, so it is outside the
      // type-aware lint the rest of the tree gets.
      "scripts/generate-prisma-client.mjs",
      // Plain Node on purpose too: it is handed to an auditor to run on its
      // own, with nothing from this repository or npm.
      "scripts/verify-ledger-export.mjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        /* A config of its own, because neither build's tsconfig covers
           everything the linter should read - see tsconfig.eslint.json. */
        project: ["./tsconfig.all.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* An unawaited promise in a request handler is a response that never
         arrives. This is the rule worth having a linter for. */
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      /* `catch (error: any)` is the one place `any` is tempting and the one
         place it hides the shape of what failed. Warn rather than error:
         narrowing every catch is a change for its own commit. */
      "@typescript-eslint/no-explicit-any": "warn",

      /* An unused parameter named `_req` is deliberate Express signature
         padding, not dead code. */
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  {
    /* Augmenting `Express.Request` - with the authenticated user in `auth.ts`,
       with the correlation id in `requestLog.ts` - is what
       `declare global { namespace Express }` is FOR: there is no module
       syntax that does the same job. */
    files: ["src/middleware/auth.ts", "src/middleware/requestLog.ts"],
    rules: { "@typescript-eslint/no-namespace": "off" },
  },

  {
    /* The `no-unsafe-*` findings that remain are all one shape: a value
       arriving from outside the type system - a parsed request body, a Prisma
       `Json` column, a spreadsheet cell - flowing on untyped. Every one is
       worth fixing and none is a one-line fix; typing them properly is its
       own piece of work, service by service.

       So they stay on as WARNINGS rather than being switched off. Off means
       nobody sees them again. Error means `npm run lint` is red from the day
       it was added and stops being read at all. A warning prints on every run
       and the count only goes down. */
    rules: {
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
    },
  },

  {
    // Tests reach into internals and build partial fixtures on purpose.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
);
