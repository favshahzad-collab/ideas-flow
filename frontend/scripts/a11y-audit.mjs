/**
 * The fourth gate, and the only one that needs the app running.
 *
 * `audit:contrast` reads the stylesheet, `audit:dead` reads the imports, the
 * test suite reads the pure functions. None of them can see a button with no
 * accessible name, an input whose label points at an id that moved, or a
 * heading level that skips — the defects that make a screen unusable with a
 * keyboard or a screen reader while looking perfect.
 *
 *   npm run dev            # in one terminal
 *   npm run audit:a11y     # in another
 *
 * Deliberately not axe-core: this checks a short list of things that are
 * always defects rather than a long list of things that are usually fine, so
 * every failure it prints is worth fixing. Add a rule when a real defect gets
 * through, not because a rule exists.
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

/* Playwright is deliberately NOT a dependency of this app: it would pull a
   browser driver into every install for one script. Find it wherever the
   machine keeps it, and say exactly what to do when it is missing rather
   than dying on a module-not-found stack. */
function loadChromium() {
  const roots = [
    process.env.PLAYWRIGHT_CORE,
    `${homedir()}/node_modules/playwright-core`,
    `${homedir()}/node_modules/playwright`,
  ].filter(Boolean);

  for (const name of ['playwright-core', 'playwright']) {
    try {
      return createRequire(import.meta.url)(name).chromium;
    } catch {
      /* not resolvable from here; try the explicit roots below */
    }
  }
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      return createRequire(`${root}/`)(root).chromium;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const chromium = loadChromium();
if (!chromium) {
  console.error(
    [
      '',
      'Cannot run: this audit drives a real browser and Playwright was not found.',
      '  npm i -D playwright-core   (then: npx playwright install chromium)',
      '  or set PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core',
      '',
    ].join('\n')
  );
  process.exit(1);
}

/* A pinned path is right on a developer machine that has a browser sitting
   somewhere Playwright did not put it, and wrong everywhere else - a Windows
   `chrome.exe` path fails instantly on a Linux CI runner. So it is a hint,
   used only if it exists; otherwise Playwright resolves its own download. */
const EXE_HINT =
  process.env.PLAYWRIGHT_CHROMIUM ??
  (process.platform === 'win32'
    ? `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1234/chrome-win64/chrome.exe`
    : null);
const LAUNCH = EXE_HINT && existsSync(EXE_HINT) ? { executablePath: EXE_HINT } : {};
const BASE = process.env.AUDIT_BASE ?? 'http://localhost:5173';
const EMAIL = process.env.AUDIT_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.AUDIT_PASSWORD ?? 'password';

/* A screen's resting state mounts no dialog, no menu and no second tab, so
   checking only that state passes every rule about them for free. Each route
   carries the interactions that put its overlays on screen.

   Openers only. Nothing here confirms anything: an audit must not be able to
   approve a document or delete a user as a side effect of running. */
const ROUTES = [
  {
    /* No 'bulk selection' step: FEATURES.bulkActions is off by default now,
       so the checkboxes are not rendered and the step could only ever
       report itself skipped. Add it back with the flag. */
    path: '/dashboard',
    steps: [
      ['row menu', p => p.locator('tbody tr button[aria-haspopup="menu"]').first().click()],
      ['command palette', p => p.keyboard.press('Control+k')],
    ],
  },
  {
    path: '/pending-approvals',
    steps: [
      ['revision dialog', p => p.getByRole('button', { name: /^Revision$/ }).first().click()],
      ['reject dialog', p => p.getByRole('button', { name: /^Reject$/ }).first().click()],
    ],
  },
  {
    path: '/submit-document',
    steps: [
      ['file step', p => p.locator('nav[aria-label="Submission steps"] button').nth(1).click()],
      ['routing step', p => p.locator('nav[aria-label="Submission steps"] button').nth(2).click()],
      /* The add-a-person dialog, reached the way a person reaches it: search
         the picker for somebody who is not there, then take the offer. It is
         only rendered for an administrator, which this audit signs in as. A
         dialog nothing ever opens is a dialog nothing ever checks. */
      ['add-person dialog', async p => {
        await p.locator('button[aria-haspopup="listbox"]').first().click();
        await p.getByLabel('Search for a person').first().fill('Nobody Here At All');
        await p.getByRole('button', { name: /as a new person/ }).first().click();
      }],
      ['sign step', p => p.locator('nav[aria-label="Submission steps"] button').nth(3).click()],
    ],
  },
  { path: '/inbox' },
  /* Everybody's own account: the password form and the signature. And the
     account menu, which is a `role="menu"` overlay on every screen in the
     app that this audit had never once opened - there used to be two of
     them, in the header and at the foot of the rail, holding the same items
     under the same name. */
  {
    path: '/account',
    steps: [
      ['account menu', p => p.getByRole('button', { name: 'Account menu' }).click()],
      /* The out-of-office card's delegate picker: a listbox, a search field
         and a live region, none of which exist until it is opened. */
      ['delegate picker', async p => {
        await p.keyboard.press('Escape');
        await p.getByRole('button', { name: 'Hand my approvals to' }).click();
      }],
    ],
  },
  { path: '/audit-ledger', steps: [['expanded group', p => p.locator('tbody button').first().click()]] },
  {
    path: '/admin/people',
    steps: [
      ['add-user dialog', p => p.getByRole('button', { name: /Add (a )?(user|person)/i }).first().click()],
      /* The departments card, in the state that has the most controls in it:
         a row being renamed, which puts a text field and two buttons where a
         moment ago there was a line of text. */
      ['department rename', async p => {
        await p.getByRole('button', { name: /^Rename / }).first().click();
      }],
      /* Picking somebody in the table fills the whole right column, which is
         otherwise audited empty: the delegation panel and the panel that says
         what stops if they go both draw nothing until a row is selected. */
      ['person selected', async p => {
        await p.keyboard.press('Escape');
        await p.locator('tbody tr').first().click();
        await p.waitForTimeout(1200);
      }],
      /* The confirmation before an account is switched off - the one dialog
         in the product that reads a second endpoint before it can say what
         the decision costs, so it has a loading state, a finding and a
         destructive button in the same box. Opening it changes nothing. */
      ['switch-off dialog', async p => {
        await p.locator('tbody tr').first().getByRole('button', { name: /^Actions for/ }).click();
        await p.waitForTimeout(400);
        await p.getByRole('menuitem', { name: 'Switch account off' }).click();
        await p.waitForTimeout(1500);
      }],
    ],
  },
  { path: '/admin/control-room' },
  /* The administration trail. A table whose rows carry no link and no action,
     plus a row of filter pills that are buttons rather than tabs - so the
     thing worth checking is that "which one is chosen" survives having no
     tablist around it. */
  {
    path: '/admin/change-history',
    steps: [
      ['area filtered', p => p.getByRole('button', { name: 'Departments' }).click()],
    ],
  },
  /* A form with a password field, a switch and two kinds of warning banner -
     and the one screen an administrator uses while something is already
     broken, which is the worst moment to meet an unlabelled control. */
  { path: '/admin/mail' },
  {
    path: '/admin/workflow-studio',
    steps: [['row menu', p => p.locator('tbody button[aria-haspopup="menu"]').first().click()]],
  },
  /* The designer was the one screen this audit never opened: it is reached
     from a button rather than the nav, so it was easy to miss when the list
     was written. It is also the most custom DOM in the app - a graph canvas
     with draggable nodes - which makes it the last screen that should have
     been taken on trust. */
  {
    path: '/admin/workflow-studio/new',
    steps: [
      ['node selected', p => p.locator('.react-flow__node').first().click()],
    ],
  },
  /*
   * The other half of People & delegation, reached by its tab rather than by
   * a row of its own. A tab state is a screen state: it went unaudited while
   * it was a page of its own, which is exactly what happens to a screen
   * nothing in the nav points at any more.
   *
   * Last, and it has to be. Its step folds the sidebar's Administration
   * group - a DOM change belonging to the shell, so it is on every screen
   * above but only ever open - and the fold is remembered in storage. Folded
   * earlier, every screen after it would be audited with a different sidebar
   * than the one this report names. The workflow designer, which used to be
   * last, hides the sidebar entirely and so cannot host this step at all.
   */
  {
    path: '/admin/access-control',
    steps: [
      ['sidebar folded', p => p.getByRole('button', { name: /Administration/ }).first().click()],
    ],
  },
];

/* One document, walked through every tab and every action dialog. */
const DETAIL_STEPS = [
  ['supporting tab', p => p.getByRole('tab', { name: /^Supporting/ }).click()],
  ['chain tab', p => p.getByRole('tab', { name: /^Chain/ }).click()],
  ['comments tab', p => p.getByRole('tab', { name: /^Comments/ }).click()],
  ['ledger tab', p => p.getByRole('tab', { name: /^Ledger/ }).click()],
  ['revision dialog', p => p.getByRole('button', { name: /^Revision$/ }).click()],
  ['reject dialog', p => p.getByRole('button', { name: /^Reject$/ }).click()],
  ['signing dialog', p => p.getByRole('button', { name: /^Sign & (approve|complete review)$/ }).click()],
  /* Two controls in one state: the dialog, and the person picker inside it,
     which is a combobox drawn over a dialog and is the only place in the
     product where one sits on top of the other. */
  ['reassign dialog', async p => {
    await p.getByRole('button', { name: /^Reassign$/ }).click();
    await p.waitForTimeout(400);
    await p.getByRole('button', { name: 'Hand this step to' }).click();
  }],
];

/* Runs in the page. Everything it needs must be defined inside it. */
function collect() {
  const problems = [];
  const say = (rule, detail) => problems.push({ rule, detail });

  const label = el => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = (el.className || '').toString().trim().split(/\s+/).slice(0, 3).join(' ');
    return `${tag}${id}${cls ? ` "${cls}"` : ''}`;
  };

  /* The name a screen reader would announce, by the same precedence order
     the accessible-name algorithm uses. */
  const accessibleName = el => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map(id => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (text) return text;
    }
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel?.textContent.trim()) return forLabel.textContent.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping?.textContent.trim()) return wrapping.textContent.trim();
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    if (el.tagName === 'INPUT' && el.getAttribute('type') === 'submit') return el.value;
    return (el.textContent ?? '').trim();
  };

  const visible = el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return el.getClientRects().length > 0 || cs.position === 'absolute';
  };

  /* 1. every control announces something */
  for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="switch"], [role="menuitem"]')) {
    if (!visible(el)) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    if (!accessibleName(el)) say('control with no accessible name', label(el));
  }

  /* 2. every form control a user can reach is labelled.
        `display: none` takes an element out of the accessibility tree
        entirely, so the file inputs behind an "upload" button are not
        defects - they are unreachable by anyone, which is the point.
        `visible()` deliberately keeps `position: absolute` elements, so an
        sr-only control still has to carry a name. */
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.type === 'hidden' || !visible(el)) continue;
    if (!accessibleName(el)) say('form control with no label', label(el));
  }

  /* 3. a label pointing at nothing is worse than no label: it looks correct
        in review and announces nothing. */
  for (const el of document.querySelectorAll('label[for]')) {
    const target = document.getElementById(el.getAttribute('for'));
    if (!target) say('label points at a missing id', `${el.getAttribute('for')} ("${el.textContent.trim().slice(0, 30)}")`);
  }

  /* 4. duplicate ids silently break label/aria wiring */
  const seen = new Map();
  for (const el of document.querySelectorAll('[id]')) {
    seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) say('duplicate id', `${id} x${count}`);
  }

  /* 5. aria-labelledby / aria-describedby / aria-controls that dangle */
  for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      for (const id of el.getAttribute(attr).split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(id)) say(`${attr} points at a missing id`, `${label(el)} -> ${id}`);
      }
    }
  }

  /* 6. images */
  for (const el of document.querySelectorAll('img')) {
    if (!visible(el)) continue;
    if (el.getAttribute('alt') === null) say('img with no alt attribute', label(el));
  }

  /* 7. one h1, and no skipped level on the way down */
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible);
  const h1s = headings.filter(h => h.tagName === 'H1');
  if (h1s.length === 0) say('no h1 on the page', '');
  if (h1s.length > 1) say('more than one h1', h1s.map(h => h.textContent.trim().slice(0, 24)).join(' | '));
  let previous = 0;
  for (const h of headings) {
    const level = Number(h.tagName[1]);
    if (previous && level > previous + 1) {
      say('heading level skipped', `h${previous} -> h${level} ("${h.textContent.trim().slice(0, 30)}")`);
    }
    previous = level;
  }

  /* 8. tab order belongs to the DOM */
  for (const el of document.querySelectorAll('[tabindex]')) {
    if (Number(el.getAttribute('tabindex')) > 0) say('positive tabindex', label(el));
  }

  /* 9. a click target that only a mouse can reach.
        React attaches its handlers at the root, so `el.onclick` is null in
        the DOM and there is nothing to inspect. `cursor: pointer` is the
        reliable tell: this app sets it exactly where it expects a click. An
        element wearing it is fine if it IS a control, or if it CONTAINS one
        that does the same job - a row whose title is a button gives the
        keyboard the same destination the mouse has. */
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"],' +
    '[role="option"], [role="menuitem"], [role="tab"], [role="switch"], [tabindex]:not([tabindex="-1"])';
  for (const el of document.querySelectorAll('*')) {
    if (!visible(el) || getComputedStyle(el).cursor !== 'pointer') continue;
    /* `cursor` INHERITS, so every span inside a clickable row reports it too.
       Only the outermost element of a pointer subtree is the click target. */
    if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
    if (el.matches(INTERACTIVE) || el.closest(INTERACTIVE)) continue;
    if (el.querySelector(INTERACTIVE)) continue;
    say('click target a keyboard cannot reach', label(el));
  }

  /* 10. landmarks */
  if (!document.querySelector('main, [role="main"]')) say('no main landmark', '');

  /* 11. a dialog has to say what it is */
  for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    if (!visible(el)) continue;
    if (el.getAttribute('aria-modal') !== 'true') say('dialog without aria-modal', label(el));
    if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) {
      say('dialog with no accessible name', label(el));
    }
  }

  /* 12. a control that toggles should say which way it is */
  for (const el of document.querySelectorAll('[role="switch"], [role="tab"], [aria-expanded]')) {
    if (!visible(el)) continue;
    const role = el.getAttribute('role');
    if (role === 'switch' && el.getAttribute('aria-checked') === null) say('switch without aria-checked', label(el));
    if (role === 'tab' && el.getAttribute('aria-selected') === null) say('tab without aria-selected', label(el));
  }

  return problems;
}

/* Every rule below passes on every screen. That is either good news or a
   broken rule, and the two look identical from the outside - so before
   auditing anything, plant one known defect per rule and require it to be
   found. A rule that stops firing fails here instead of quietly passing
   forever.

   Each entry is [rule name, HTML that violates it]. */
const SELF_TEST = [
  ['control with no accessible name', '<button></button>'],
  ['form control with no label', '<input type="text">'],
  ['label points at a missing id', '<label for="nothing-here">Name</label>'],
  ['duplicate id', '<span id="twice"></span><span id="twice"></span>'],
  ['aria-labelledby points at a missing id', '<button aria-labelledby="gone">x</button>'],
  ['img with no alt attribute', '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'],
  ['heading level skipped', '<h1>a</h1><h3>b</h3>'],
  ['positive tabindex', '<div tabindex="3">x</div>'],
  ['click target a keyboard cannot reach', '<div style="cursor:pointer">Open</div>'],
  ['dialog without aria-modal', '<div role="dialog" aria-label="x">x</div>'],
  ['switch without aria-checked', '<div role="switch" aria-label="x">x</div>'],
  ['tab without aria-selected', '<div role="tab" aria-label="x">x</div>'],
];

async function selfTest(page) {
  const missed = [];
  for (const [rule, html] of SELF_TEST) {
    const found = await page.evaluate(
      ({ markup, collectSource }) => {
        const host = document.createElement('div');
        host.id = '__a11y_self_test__';
        host.innerHTML = markup;
        document.body.appendChild(host);
        /* `collect` is serialised and rebuilt here so the self test runs the
           very same function the audit runs - a second copy could drift and
           certify a rule that no longer exists. */
        const problems = new Function(`return (${collectSource})`)()();
        host.remove();
        return problems.map(p => p.rule);
      },
      { markup: html, collectSource: collect.toString() },
    );
    if (!found.includes(rule)) missed.push(rule);
  }
  return missed;
}

const browser = await chromium.launch(LAUNCH);
const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(`${page.url()}  ${e.message}`));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });

let total = 0;
let skipped = 0;

console.log('=== self test ===');
const missed = await selfTest(page);
if (missed.length) {
  total += missed.length;
  for (const rule of missed) console.log(`  FAIL  rule never fires: ${rule}`);
} else {
  console.log(`  ok — all ${SELF_TEST.length} rules catch a planted defect`);
}

console.log('\n=== /login ===');
const report = async route => {
  await page.waitForTimeout(1200);
  const problems = await page.evaluate(collect);
  if (problems.length === 0) {
    console.log(`  ok — ${route}`);
    return;
  }
  total += problems.length;
  console.log(`  ${route}`);
  for (const p of problems) console.log(`    FAIL  ${p.rule}${p.detail ? `: ${p.detail}` : ''}`);
};

await report('/login');

await page.fill('#email', EMAIL);
await page.fill('#password', PASSWORD);
await page.click('button[type="submit"]');

/*
 * Sign in, and say which of the two things went wrong when it does not.
 *
 * This used to be a bare `waitForURL`, so a refused credential surfaced as
 * `TimeoutError: page.waitForURL: Timeout 20000ms exceeded` and a Node stack
 * trace twenty seconds later — which reads as the audit being broken, and
 * says nothing about the password being wrong. It cost an afternoon twice:
 * the defaults below match `prisma/seed.ts` with no SEED_ADMIN_* set, which
 * is what CI seeds and is exactly what a real deployment does NOT have.
 *
 * The screen itself knows the answer and puts it in an alert, so the race is
 * between the redirect and that alert rather than against a timeout.
 */
const landed = await Promise.race([
  page
    .waitForURL((url) => !url.pathname.includes('/login'), { timeout: 25000 })
    .then(() => 'in')
    .catch(() => 'timeout'),
  page
    .waitForSelector('[role="alert"]', { timeout: 25000 })
    .then(async (el) => (await el.textContent()) || 'it refused without saying why')
    .catch(() => 'timeout'),
]);

if (landed !== 'in') {
  const refusal = landed === 'timeout' ? '' : ` The screen said: ${landed.trim()}`;
  console.error(
    [
      '',
      `Cannot sign in as ${EMAIL}, so only /login was checked.${refusal}`,
      '',
      '  This audit drives the real app, so it needs an account on the database',
      '  the app is pointed at. The defaults are the ones `prisma/seed.ts` uses',
      '  when SEED_ADMIN_* is unset, which is what CI seeds — a deployment that',
      '  set its own, or has since changed the password, has to say so:',
      '',
      '    AUDIT_EMAIL=you@example.com AUDIT_PASSWORD=... npm run audit:a11y',
      '',
    ].join('\n')
  );
  await browser.close();
  process.exit(1);
}

/* Escape closes every overlay in this app; a second one is harmless and
   covers a menu opened inside a dialog. */
const dismiss = async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
};

const walk = async (path, steps) => {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await report(path);
  for (const [name, open] of steps ?? []) {
    try {
      await open(page);
    } catch {
      /* The state that would show this control is not present. Say so, and
         count it: a run that skipped half its steps checked half as much as
         one that did not, and both would otherwise print PASS. */
      console.log(`    skip  ${name} — not reachable on this data`);
      skipped += 1;
      continue;
    }
    await page.waitForTimeout(900);
    await report(`${path}  [${name}]`);
    await dismiss();
  }
};

console.log('\n=== signed in ===');
for (const route of ROUTES) {
  await walk(route.path, route.steps);
}

/* The document detail screen has no route of its own without an id. */
/* Which document gets opened decides whether the Revision, Reject and signing
   dialogs are reachable at all - on a document the signed-in user cannot act
   on, three of the detail steps skip and quietly test nothing. So it comes
   from MY QUEUE, where by definition there is something to act on, and only
   falls back to the table if the queue is empty. */
let firstDocument = null;
for (const [source, open] of [
  ['my queue', async () => {
    await page.goto(BASE + '/pending-approvals', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: /^Sign & (approve|complete review)$/i }).first().click();
  }],
  ['the documents table', async () => {
    await page.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.locator('tbody tr td button').first().click();
  }],
]) {
  try {
    await open();
    await page.waitForURL(url => url.pathname.startsWith('/documents/'), { timeout: 10000 });
    firstDocument = new URL(page.url()).pathname;
    console.log(`  (detail screen opened from ${source})`);
    break;
  } catch {
    /* try the next source */
  }
}

if (firstDocument) {
  await walk(firstDocument, DETAIL_STEPS);
} else {
  /*
   * There being no document and there being a document that will not open are
   * different findings, and this reported both as the second one.
   *
   * On a seeded run they are the same thing, which is why it went unnoticed:
   * CI always has documents, so "could not open one" always did mean a defect.
   * Run against a real install on its first day - the state the fresh-install
   * job exists to check - the audit failed for having nothing to look at, and
   * an audit that cries wolf on an empty database is one people learn to run
   * with a known failure.
   *
   * So: count it only when there was something to open.
   */
  await page.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const rows = await page.locator('tbody tr').count();

  if (rows === 0) {
    console.log('    skip  document detail — no documents on this install');
    skipped += 1;
  } else {
    console.log(`  FAIL  could not open a document from the table (${rows} rows present)`);
    total += 1;
  }
}

/* The two states the preparer lands in when a memo comes back.
   Neither is reachable from the walk above - that one deliberately opens a
   document the signed-in user can ACT on, and by definition a rejected or
   returned memo is not one. Both render a banner carrying the reviewer's
   reason, which is the sentence the preparer acts on, so both are worth a
   pass of their own. Found through the API rather than by hunting the table
   for a badge: the demo seed makes one of each, but not at a fixed position. */
const token = await page.evaluate(() => localStorage.getItem('docflow_auth_token'));
for (const status of ['REVISION_REQUESTED', 'REJECTED']) {
  const id = await page.evaluate(
    async ([wanted, bearer]) => {
      const response = await fetch('/api/documents?limit=100', {
        headers: { authorization: `Bearer ${bearer}` },
      });
      if (!response.ok) return null;
      const body = await response.json();
      const list = body.documents ?? body.data ?? body;
      return (Array.isArray(list) ? list : []).find(d => d.status === wanted)?.id ?? null;
    },
    [status, token],
  );

  if (id) {
    console.log(`  (${status.toLowerCase()} memo — the banner the preparer lands on)`);
    await walk(`/documents/${id}`, []);
  } else {
    console.log(`  (no ${status} document seeded - banner not walked)`);
  }
}

if (consoleErrors.length) {
  total += consoleErrors.length;
  console.log('\n  uncaught errors:');
  for (const e of consoleErrors) console.log(`    FAIL  ${e}`);
}

console.log(
  `\n${total ? `${total} ACCESSIBILITY FAILURE(S)` : 'ALL SCREENS PASS'}` +
  `${skipped ? `  (${skipped} step${skipped === 1 ? '' : 's'} skipped - that much went unchecked)` : ''}\n`
);
await browser.close();
process.exit(total ? 1 : 0);
