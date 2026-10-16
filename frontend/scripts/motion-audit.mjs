/**
 * Motion that never stops.
 *
 * `audit:contrast` reads the stylesheet for colour, `audit:dead` reads the
 * imports, `audit:a11y` drives the real app. This one reads the stylesheet for
 * movement, and it exists because the other three cannot see this:
 *
 *   - the accessibility audit walks a RESTING DOM, and an animation is not in
 *     the DOM. A logo pulsing on a four-second loop, on every screen, all day,
 *     passed that audit green.
 *   - the contrast audit is about colour.
 *   - a vitest test would be the obvious home, except nothing under `src/` may
 *     import `node:fs` - `tsconfig.app.json` is the browser config and carries
 *     no node types, so the build refuses it. Hence a script, like its three
 *     siblings.
 *
 * The rule. An endless animation is a claim that something is happening: the
 * eye reads repeated movement as "this changed, look here". A thing that says
 * so forever and never means it spends the day crying wolf, and this is a
 * product people READ in - memos, approval chains, audit trails.
 *
 * It is also WCAG 2.2 SC 2.2.2 (Pause, Stop, Hide), a Level A criterion:
 * content that moves by itself, runs past five seconds and sits alongside
 * other content needs an in-page way to stop it. `prefers-reduced-motion` is
 * not that mechanism - it is an OS setting almost nobody has found - and the
 * app chrome offers no pause control. A FINITE animation is out of scope of
 * the criterion entirely, which is why this audit is about looping and not
 * about animation as such.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(here, '..', 'src', 'index.css');
const css = fs.readFileSync(cssPath, 'utf8');

/** The only animations allowed to run forever, and what each has earned it. */
const MAY_LOOP_FOREVER = {
  'progress-pending': 'a progress bar — it loops because work is in flight',
  livedot: 'the Live pill — it loops because the connection really is live',
};

let failures = 0;

console.log('\n=== ANIMATIONS THAT NEVER STOP ===');

/* The longhand first. Everything below reads the `animation:` shorthand to
   learn a looping animation's NAME, so a longhand iteration-count would slip
   past the whole audit unnamed. */
const longhand = [...css.matchAll(/animation-iteration-count:\s*infinite/g)];
if (longhand.length) {
  failures += longhand.length;
  console.log(
    `  FAIL  ${longhand.length} × \`animation-iteration-count: infinite\`` +
      '  → declare loops in the `animation:` shorthand so this audit can name them'
  );
} else {
  console.log('  ok — every loop is declared in the shorthand, so every loop is named');
}

const looping = [
  ...new Set([...css.matchAll(/animation:\s*([\w-]+)[^;}]*\binfinite\b/g)].map(m => m[1])),
];

for (const name of looping.sort()) {
  const why = MAY_LOOP_FOREVER[name];
  if (why) {
    console.log(`  ok — ${name}: ${why}`);
  } else {
    failures += 1;
    console.log(
      `  FAIL  ${name} loops forever and represents nothing in flight` +
        '\n        → make it finite (an entrance, a response to input), or, if it' +
        '\n          really does show live state, add it to MAY_LOOP_FOREVER here' +
        '\n          with the reason it has earned.'
    );
  }
}

/* Named outright, because this is the regression the audit was written for:
   the company mark on the sidebar used to pulse every four seconds. A logo is
   not a status. */
console.log('\n=== THE COMPANY MARK ===');
const petal = css.slice(css.indexOf('.ideas-mark-petal {'));
const petalRule = petal.slice(0, petal.indexOf('}'));

if (!petalRule.includes('animation:')) {
  failures += 1;
  console.log('  FAIL  .ideas-mark-petal has no animation at all — is the rule still there?');
} else if (petalRule.includes('infinite')) {
  failures += 1;
  console.log('  FAIL  the mark pulses forever again. A logo is not a status.');
} else {
  console.log('  ok — the mark settles once and is then still');
}

/* The reduced-motion block cuts every animation to a single 0.01ms iteration,
   which lands on its LAST keyframe. That is only safe if the last keyframe is
   the finished thing. An entrance written the other way round leaves the mark
   stranded part-drawn for exactly the people who can least afford it. */
const settle = css.slice(css.indexOf('@keyframes ideas-mark-settle'));
const lastFrame = settle.slice(settle.indexOf('  to {'), settle.indexOf('\n}'));

if (lastFrame.includes('opacity: 1') && lastFrame.includes('transform: scale(1)')) {
  console.log('  ok — its last keyframe is the finished mark, so reduced motion lands whole');
} else {
  failures += 1;
  console.log(
    '  FAIL  the last keyframe of ideas-mark-settle is not the finished mark' +
      '\n        → reduced motion jumps straight to it; it must be full size and opaque'
  );
}

if (!petalRule.includes('both')) {
  failures += 1;
  console.log(
    '  FAIL  .ideas-mark-petal has no `both` fill' +
      '\n        → without it the petals flash in before their delay, and reduced' +
      '\n          motion has no final frame to land on'
  );
} else {
  console.log('  ok — `both`, so the delay holds the start and the end sticks');
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL CHECKS PASS'}\n`);
process.exit(failures ? 1 : 0);
