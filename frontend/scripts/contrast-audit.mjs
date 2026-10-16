/**
 * Token contrast audit.
 *
 * Reads the `@theme` and `:root[data-theme='dark']` blocks out of
 * `src/index.css` and checks every pairing the design actually puts on
 * screen, in BOTH themes. Run it after any token change:
 *
 *   npm run audit:contrast
 *
 * This checks the TOKENS, which is where a palette failure originates. It
 * does not replace looking at a rendered page — a page-wide sweep of the
 * running app is what catches a component pairing two tokens that were
 * never meant to meet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, '..', 'src', 'index.css'), 'utf8');

function block(startRe) {
  const i = css.search(startRe);
  if (i < 0) throw new Error('block not found: ' + startRe);
  let depth = 0;
  const open = css.indexOf('{', i);
  for (let k = open; k < css.length; k++) {
    if (css[k] === '{') depth++;
    else if (css[k] === '}' && !--depth) return css.slice(open, k);
  }
  throw new Error('unterminated block: ' + startRe);
}

const tokens = (src) =>
  Object.fromEntries(
    [...src.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]])
  );

const light = tokens(block(/@theme \{/));
const dark = { ...light, ...tokens(block(/:root\[data-theme='dark'\] \{/)) };

const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) =>
  0.2126 * channel(parseInt(hex.slice(1, 3), 16) / 255) +
  0.7152 * channel(parseInt(hex.slice(3, 5), 16) / 255) +
  0.0722 * channel(parseInt(hex.slice(5, 7), 16) / 255);
const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const TEXT = 4.5; // WCAG 1.4.3, body and small text
const UI = 3.0;   // WCAG 1.4.11, control boundaries

/** [foreground, background, minimum] */
const PAIRS = [
  // body text on each of the three light surfaces
  ['content', 'canvas', TEXT], ['content', 'surface', TEXT], ['content', 'sunken', TEXT],
  ['content-muted', 'canvas', TEXT], ['content-muted', 'surface', TEXT], ['content-muted', 'sunken', TEXT],
  ['content-subtle', 'canvas', TEXT], ['content-subtle', 'surface', TEXT], ['content-subtle', 'sunken', TEXT],

  // the label on a saturated fill
  ['on-accent', 'accent', TEXT], ['on-accent', 'accent-hover', TEXT], ['on-accent', 'accent-active', TEXT],
  ['content-inverse', 'danger', TEXT], ['content-inverse', 'danger-hover', TEXT],

  // status text on its own tint, and on a plain card
  ['accent-ink', 'accent-soft', TEXT], ['accent-ink', 'surface', TEXT],
  ['danger-ink', 'danger-soft', TEXT], ['danger-ink', 'surface', TEXT],
  ['warning-ink', 'warning-soft', TEXT], ['warning-ink', 'surface', TEXT],
  ['info-ink', 'info-soft', TEXT], ['info-ink', 'surface', TEXT],
  ['revision-ink', 'revision-soft', TEXT], ['revision-ink', 'surface', TEXT],
  ['success-ink', 'success-soft', TEXT], ['success-ink', 'surface', TEXT],
  ['neutral', 'neutral-soft', TEXT], ['neutral', 'surface', TEXT],

  /* The unsuffixed semantic tokens are FILLS: a solid with a light label on
     it. In the light theme each is identical to its `-ink`, which is why
     using one as text there looked fine; in the dark theme they diverge, and
     `danger` measures 3.44:1 as text. The source scan below is what keeps
     them out of a `text-*` class. */
  /* `danger` and `accent` are the only two used as a solid with a light
     label on them, and both hold 4.5:1 in each theme. The others are text
     and tint colours; in the dark theme they are light hues, so white on
     `warning` measures 2.5:1. The source scan below is what stops one being
     pressed into service as a fill. */

  // the navy rail
  ['shell-text', 'shell', TEXT], ['shell-label', 'shell', TEXT], ['shell-muted', 'shell', TEXT],

  // the two monitoring screens, which stay dark in both themes
  ['dark-content', 'dark-surface', TEXT], ['dark-content', 'dark-canvas', TEXT],
  ['dark-content-muted', 'dark-surface', TEXT], ['dark-content-muted', 'dark-canvas', TEXT],
  ['dark-content-muted', 'dark-header', TEXT],
  ['dark-content-subtle', 'dark-surface', TEXT], ['dark-content-subtle', 'dark-canvas', TEXT],
  ['dark-content-subtle', 'dark-header', TEXT],

  /* The semantic accents the dark screens put on screen AS TEXT — a node's
     kind label, a stat value, a breach line. They are fixed in both themes,
     but both are still checked: a later edit that made one of them
     theme-dependent would otherwise pass here and fail on screen. */
  ['dark-accent', 'dark-surface', TEXT], ['dark-accent', 'dark-canvas', TEXT],
  ['dark-accent', 'dark-header', TEXT],
  ['dark-danger', 'dark-surface', TEXT], ['dark-danger', 'dark-canvas', TEXT],
  ['dark-danger', 'dark-header', TEXT],
  ['dark-warning', 'dark-surface', TEXT], ['dark-warning', 'dark-canvas', TEXT],
  ['dark-info', 'dark-surface', TEXT], ['dark-info', 'dark-canvas', TEXT],
  ['dark-revision', 'dark-surface', TEXT], ['dark-revision', 'dark-header', TEXT],

  // the boundary that identifies a form control
  ['line-strong', 'surface', UI], ['line-strong', 'sunken', UI], ['line-strong', 'canvas', UI],
  ['dark-line-strong', 'dark-surface', UI], ['dark-line-strong', 'dark-canvas', UI],

  /* The sign-in screen, which carries its own palette.
     It is the one screen every user meets before they have an account page
     to complain from, and the handoff it was built to fails three of these
     as written - see the note beside the tokens in index.css. */
  ['auth-text', 'auth-bg', TEXT], ['auth-text', 'auth-surface', TEXT],
  ['auth-ink', 'auth-bg', TEXT], ['auth-ink', 'auth-surface', TEXT],
  /* The tinted badge behind an icon on this screen. `auth-soft-line` is not
     here for the same reason `accent-line` is not: it is a tint's own edge,
     not the boundary that identifies a control - the fill does that. */
  ['auth-ink', 'auth-soft', TEXT],
  ['auth-on-fill', 'auth-fill', TEXT], ['auth-on-fill', 'auth-fill-hover', TEXT],
  ['auth-error', 'auth-surface', TEXT],
  /* The brand panel, which keeps its own dark ground in both themes.

     Checked against `auth-panel-lift` as well as `auth-panel`. The panel is
     lit by three gradient layers, so the flat token is no longer the ground
     anything actually sits on - `lift` is the brightest point those layers
     reach, which makes it the worst case for every light value here. Without
     this second column the whole panel could be brightened to the edge of
     unreadable and the audit would still pass on a colour nothing is drawn
     on. */
  ['auth-panel-text', 'auth-panel', TEXT],
  ['auth-panel-muted', 'auth-panel', TEXT],
  ['auth-panel-faint', 'auth-panel', TEXT],
  ['auth-status', 'auth-panel', TEXT],
  ['auth-panel-text', 'auth-panel-lift', TEXT],
  ['auth-panel-muted', 'auth-panel-lift', TEXT],
  ['auth-panel-faint', 'auth-panel-lift', TEXT],
  ['auth-status', 'auth-panel-lift', TEXT],
  ['auth-line-strong', 'auth-surface', UI], ['auth-line-strong', 'auth-bg', UI],
  ['auth-accent', 'auth-panel', UI], ['auth-accent', 'auth-surface', UI],
  ['auth-accent', 'auth-panel-lift', UI],
];

/**
 * The `-mark` hues are the handoff's brand values, used for status dots,
 * stage pips, SLA bars and connectors. They sit below 3:1 on a white card
 * and that is accepted: every one of them appears BESIDE the same
 * information in text (the status pill carries its word, the SLA bar
 * carries its value), so no meaning is ever conveyed by the hue alone.
 * Printed for visibility, never failed.
 */
const MARKS = ['accent-mark', 'danger-mark', 'warning-mark', 'info-mark', 'revision-mark', 'success-mark'];

let failures = 0;

for (const [name, theme] of [['LIGHT', light], ['DARK', dark]]) {
  const rows = [];
  for (const [fg, bg, min] of PAIRS) {
    if (!theme[fg] || !theme[bg]) {
      rows.push(`  MISSING  ${fg} or ${bg}`);
      failures++;
      continue;
    }
    const r = ratio(theme[fg], theme[bg]);
    if (r < min) {
      failures++;
      rows.push(`  FAIL  ${r.toFixed(2)}:1 (needs ${min})  ${fg} on ${bg}  ${theme[fg]} / ${theme[bg]}`);
    }
  }
  console.log(`\n=== ${name} — ${PAIRS.length} pairs ===`);
  console.log(rows.length ? rows.join('\n') : '  all pass');
  console.log(
    '  marks (decorative, always paired with text): ' +
      MARKS.map((m) => `${m} ${ratio(theme[m], theme.surface).toFixed(2)}:1`).join(', ')
  );
  console.log(
    '  dark-content-faint (rules and disabled glyphs only, never text): ' +
      `${ratio(theme['dark-content-faint'], theme['dark-surface']).toFixed(2)}:1 on dark-surface`
  );
}

/* ------------------------------------------------------------------ *
 * Source scan
 *
 * Contrast maths cannot see which token a component reaches for, and the
 * failure this catches was invisible for exactly that reason: in the light
 * theme `danger` and `danger-ink` are the same hex, so `text-danger` looked
 * correct everywhere it was written, and only the dark theme — where they
 * diverge — put error text at 3.44:1.
 *
 * The rule: `-ink` is text, unsuffixed is a fill, `-mark` is a dot.
 * ------------------------------------------------------------------ */
const SEMANTIC = ['danger', 'warning', 'success', 'info', 'revision'];

// `text-danger`, but not `text-danger-ink` and not `text-dark-danger`.
const badText = new RegExp(
  String.raw`(?<![\w-])text-(${SEMANTIC.join('|')})(?![-\w])`,
  'g'
);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/* `bg-warning` and friends as a SOLID fill. In the dark theme these are
   light hues, so whatever label goes on them will not clear 4.5:1 —
   `text-white bg-warning` measured 2.52:1. Only `danger` and `accent` are
   built to carry a label. `-soft` / `-line` / `-mark` are unaffected. */
const badFill = new RegExp(
  String.raw`(?<![\w-])bg-(${SEMANTIC.filter(t => t !== 'danger').join('|')})(?![-\w])`,
  'g'
);

/* A raw opaque colour bypasses the token set entirely: a rebrand edits
   index.css and silently misses every one of them. The translucent form
   (`bg-white/6`) is exempt — that is a scrim lightening whatever is behind
   it, not a colour standing in for a token. */
const rawColour = /(?<![\w-])(?:text|bg|border)-(?:white|black)(?![-\w/])/g;

/* Tailwind's stock type scale alongside the role slots is two systems: a
   heading set in `text-base` and one set in `text-section` drift apart the
   moment either moves. `text-2xs` is a role slot and is left alone.
   The map: eyebrow 10 · data 10.5 · 2xs 11 · meta 11.5 · ui 12.5 ·
   section 13 · pane 17 · title 24 · kpi 26. */
const legacyType = /(?<![\w-])text-(xs|sm|base|lg|xl|[2-9]xl)(?![-\w])/g;

/* The Button primitive owns the filled variants, and it owns them alone. A raw
   element that spells `bg-accent … hover:bg-accent-hover` is another copy of a
   button: fifteen of them existed, and the same primary action rendered at h-8,
   h-8.5, h-9 and h-10 on four different screens, each with its own hand-rolled
   spinner. The hover pair is the tell - nothing but a button needs it. */
const handRolledButton = /(?<![\w-])hover:bg-(accent|danger)-hover(?![-\w])/g;

/* An exemption has to be written down and printed on every run, or it is just
   drift with a comment. */
const ALLOWED = {
  'components/ui/Button.tsx': 'is the primitive',
  'pages/WorkflowDesigner.tsx':
    'fixed-dark toolbar; its row-mates are dark-* outlines Button has no variant for',
};

/* One focus treatment for the whole app, declared once in the base layer as a
   translucent outline. A component that adds `focus:ring-2` paints a SECOND
   indicator over it, and `focus:border-*` recolours the control on focus, so
   the same textarea announced focus in teal in one modal, red in another and
   amber in a third. `focus-visible:` utilities are a different string and do
   not trip this. */
const rivalFocus = /(?<![\\w-])focus:(?:ring|outline|border)\\b/g;

const CHECKS = [
  [badText, 'semantic token as text', 'use the -ink variant'],
  [badFill, 'semantic token as a solid fill', 'use the -soft tint, or accent/danger'],
  [rawColour, 'raw colour outside the token set', 'use content-inverse / surface'],
  [legacyType, 'stock type scale instead of a role slot', 'use text-meta / text-ui / text-section / text-pane'],
  [handRolledButton, 'button hand-rolled instead of the primitive', 'use <Button variant=…>'],
  [rivalFocus, 'focus style competing with the global one', 'delete it - :focus-visible in the base layer covers every control'],
];

const JSX_ONLY = new Set([handRolledButton, rivalFocus]);

const src = path.join(here, '..', 'src');
const files = walk(src);

console.log('\n=== SOURCE ===');
for (const [pattern, what, fix] of CHECKS) {
  const offenders = [];
  const allowed = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(src, file).split(path.sep).join('/');
    /* Both of these are questions about component markup. index.css is
       where the shared answer LIVES: `.sidebar-nav-item.active` wears the
       same accent fill, and the base layer owns `:focus-visible`. */
    if (JSX_ONLY.has(pattern) && !rel.endsWith('.tsx')) continue;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      const where = `${rel}:${line}  ${match[0]}`;
      if (pattern === handRolledButton && ALLOWED[rel]) allowed.push(`${where}  (${ALLOWED[rel]})`);
      else offenders.push(where);
    }
  }
  for (const a of allowed) console.log(`    note  ${a}`);
  if (offenders.length) {
    failures += offenders.length;
    console.log(`  ${what}:`);
    for (const o of offenders) console.log(`    FAIL  ${o}  → ${fix}`);
  } else {
    console.log(`  ok — no ${what}`);
  }
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL CHECKS PASS'}\n`);
process.exit(failures ? 1 : 0);
