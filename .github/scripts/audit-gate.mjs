/**
 * Dependency advisories, gated on whether anybody has actually judged them.
 *
 * The gate this replaces blocked on `critical` only, and the comment beside it
 * argued the case: four high advisories were open, all of them under the
 * Prisma CLI, none of them reachable from a request - and a gate that is red
 * on day one stops being read.
 *
 * The argument was right and the list was wrong. A `multer` advisory sat in
 * that same "high" bucket for weeks: four issues on the authenticated upload
 * path, one of them a file size limit bypass, in the library that enforces
 * this application's 20 MB cap. It was not unreachable, nobody had judged it,
 * and `--audit-level=critical` said nothing at all.
 *
 * So the threshold is not the thing to tune. What matters is the difference
 * between an advisory somebody has looked at and written down, and one that
 * has just arrived. This blocks on every high and critical EXCEPT the ones
 * named below with a reason - and a critical can never be named, because
 * "we looked and it is fine" is not a judgement anybody should be able to
 * make about a critical in a build script.
 *
 * Adding a package here is a deliberate act with your name on it in the git
 * history. Removing one is what happens when the dependency is fixed.
 *
 * Usage: node ../.github/scripts/audit-gate.mjs   (cwd = the package)
 */
import { execFileSync } from 'node:child_process'

/**
 * Advisories that have been looked at and judged not to apply here.
 *
 * Keyed by the package npm names in its report. Say WHY - a bare package name
 * is indistinguishable from somebody silencing a warning to get a green tick.
 */
const JUDGED = {
  mysql2:
    'Arrives under the Prisma CLI. This datasource is postgresql, so the ' +
    'MySQL driver is never loaded. npm’s proposed fix is prisma@6, a ' +
    'downgrade from the major this project is built on.',
  'deepmerge-ts':
    'Arrives under @prisma/config, which reads a trusted local config file ' +
    'at CLI time and never anything from a request.',
  '@prisma/config':
    'Same path as deepmerge-ts: CLI-time config parsing, not request input.',
  prisma:
    'The CLI itself, flagged only because of the two above. It is not in the ' +
    'request path; `migrate deploy` runs at deploy time.',
  'node-forge':
    'The advisory is about VERIFYING an RSA PKCS#1 v1.5 signature (a forged ' +
    'one can be accepted). The API never verifies one: it reads the seal ' +
    'certificate (unlocked by a PKCS#12 MAC, not an RSA signature), signs, ' +
    'and makes certificates. The only RSA verify is `lib/pdfSealVerify`, ' +
    'which only the tests import. The seal is checked by the reader (Adobe), ' +
    'which does not use node-forge. No fixed version exists yet.',
  '@signpdf/signer-p12':
    'Flagged only because it uses node-forge, to SIGN; see node-forge above.',
}

const SEVERITIES = new Set(['high', 'critical'])

function audit() {
  try {
    // Exits non-zero whenever anything is found, so the output is the point
    // and the status is not.
    return execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === 'win32',
    })
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim()) return error.stdout
    throw error
  }
}

const report = JSON.parse(audit())
const found = Object.values(report.vulnerabilities ?? {}).filter(v =>
  SEVERITIES.has(v.severity),
)

const titlesOf = v =>
  (v.via ?? [])
    .filter(entry => typeof entry !== 'string')
    .map(entry => entry.title)
    .join('; ') || '(via a dependency listed separately)'

// A critical is never excusable from in here, whatever the allowlist says.
const blocking = found.filter(v => v.severity === 'critical' || !(v.name in JUDGED))
const excused = found.filter(v => v.severity === 'high' && v.name in JUDGED)

for (const v of excused) {
  console.log(`  judged  ${v.severity.padEnd(8)} ${v.name}`)
  console.log(`          ${JUDGED[v.name]}`)
}

for (const v of blocking) {
  console.log(`  BLOCKS  ${v.severity.padEnd(8)} ${v.name}  ${v.range}`)
  console.log(`          ${titlesOf(v)}`)
  console.log(
    `          fix available: ${
      typeof v.fixAvailable === 'object'
        ? `${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (major)' : ''}`
        : String(v.fixAvailable)
    }`,
  )
}

if (blocking.length === 0) {
  console.log(
    excused.length === 0
      ? 'No high or critical advisories in the shipped tree.'
      : `\nNo unjudged advisories. ${excused.length} judged and recorded above.`,
  )
  process.exit(0)
}

console.log(
  `\n${blocking.length} advisor${blocking.length === 1 ? 'y has' : 'ies have'} not been judged.` +
    '\nFix it, or add it to JUDGED in this file with the reason it does not apply.',
)
process.exit(1)
