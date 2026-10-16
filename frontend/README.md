# DAWS frontend

React 19 + Vite UI for the Document Approval Workflow System.

```bash
npm ci
npm run dev          # http://localhost:5173
```

`/api` is proxied to `http://localhost:3000`, so the backend has to be running
too — see [`../backend/README.md`](../backend/README.md). There is no API URL
variable; the proxy is configured in `vite.config.ts` for both `dev` and
`preview`.

Optional settings live in [`.env.example`](.env.example) — copy it to
`.env.local`. Everything in it is a feature flag, and every flag has a default.

## The gates

Four checks, and they exist because convention alone had already drifted. Run
all of them before calling a change done.

| Command | What it proves |
|---|---|
| `npm run build` | Types and bundle. Use this, never `tsc --noEmit` |
| `npm test` | Two vitest projects: `unit` (pure logic, in Node) and `dom` (components and hooks, in jsdom) - 1,884 tests, none expected to fail |
| `npm run lint` | ESLint, including the React Compiler rules |
| `npm run audit:contrast` | Colour and type, statically |
| `npm run audit:dead` | Nothing left behind |
| `npm run audit:a11y` | Accessibility, in a real browser |

### `audit:contrast`

Parses the `@theme` block out of `index.css` and checks **56 token pairs in
both themes**, then scans the source for six things a contrast calculation
cannot see, because they depend on which token a component reached for:

- a semantic token used as text (`text-danger` where `text-danger-ink` is meant)
- one used as a solid fill (only `danger` and `accent` carry a white label)
- a raw colour outside the token set
- Tailwind's stock type scale instead of a role slot
- a button hand-rolled instead of the `Button` primitive
- a focus style competing with the global one

The source scan exists because of a bug only it could find: in the light theme
`--color-danger` and `--color-danger-ink` are the same hex, so `text-danger`
looked correct in all 63 places it was written — and measured 3.44:1 in dark.

Exemptions are listed in the script and **print on every run**. An exemption
nobody sees is drift with a comment attached.

### `audit:dead`

Two questions, because they catch different things: is every module reachable
from `main.tsx` (dead *files*), and does every export have a consumer (dead
*symbols* inside a live file). Exports used only within their own module, or
only by a test, are reported as notes rather than failures.

### `audit:a11y`

The only gate that needs the app running:

```bash
npm run dev          # one terminal
npm run audit:a11y   # another
```

Twelve rules across **28 screen states** — it opens the row menus, the command
palette, each wizard step, each detail tab and each action dialog, because a
screen's resting state mounts none of them and would pass every rule about them
for free. Nothing it clicks ever confirms anything.

It **self-tests first**: one planted defect per rule, checked with the same
function the audit runs. `ok — all 12 rules catch a planted defect` is what
makes `ALL SCREENS PASS` mean something.

Playwright is deliberately not a dependency — it would pull a browser driver
into every install for one script. The audit finds it on the machine, or tells
you how to install it.

## The design system

Tokens live in `src/index.css` under `@theme`. Components style against them;
no hex in a component, ever.

Two values deliberately differ from the design handoff, both for contrast:

- **`--color-accent` is `#00806C`**, not the handoff's `#00A98F`. White on
  `#00A98F` measures 2.97:1, and every primary button and active nav item sets
  a label on it. The exact handoff hue survives as `--color-accent-mark` for
  dots, pips and rules — things with no text on them.
- **`--color-line-strong` is `#828C9A`**, not `#D1D5DB` (1.47:1 on white; a
  form-control boundary needs 3:1).

That generalised into the naming rule the whole palette follows: `-mark` is a
non-text fill, `-ink` is the text weight, and an unsuffixed token is safe as a
fill under a white label.

**Type is a role scale**, not sizes: eyebrow 10 · data 10.5 · 2xs 11 · meta
11.5 · ui 12.5 · section 13 · pane 17 · title 24 · kpi 26. Every screen renders
5–9 of them and nothing else.

## Notes

- The two monitoring screens keep a **fixed dark ground in both themes**, so
  what sits on them is fixed too — `--color-dark-*`, defined once outside the
  theme switch.
- Focus is one treatment for the whole app, declared once in the base layer.
  `--transition-colours` exists because Tailwind v4 added `outline-color` to
  `transition-colors`, which made the ring fade in from `currentColor`.
- After any token change, confirm the new utilities actually reach
  `dist/assets/index-*.css`. Grep with `grep -F`: CSS escapes the dot in
  fractional names (`.h-8\.5`), so a regex `.` reports a false miss.
