/**
 * The third gate, alongside `audit:contrast` and the test suite.
 *
 * A ten-step redesign replaces screens, and what it replaces does not delete
 * itself. Four components survived that way (`IdeasBrandPanel`,
 * `WorkflowStatusPanel`, `PendingCard`, `QueueToolbar`) and so did
 * `DocumentDetails`, still compiling, still linting, rendering nowhere. Worse
 * was `ui/Eyebrow`: written once and imported by nothing while its markup was
 * hand-copied into twelve files — a primitive that exists but is not the
 * spelling anyone uses is drift with a clean bill of health.
 *
 * Two questions, because they catch different things:
 *   1. Is every module reachable from `main.tsx`?  (finds dead ISLANDS — a
 *      component whose only importer is itself dead)
 *   2. Is every export imported by somebody?        (finds dead SYMBOLS inside
 *      a module that is otherwise alive)
 *
 * Deliberately conservative: it resolves relative specifiers only, treats
 * `import * as ns` as consuming the whole module, and reports exports whose
 * sole consumer is a test as a warning rather than a failure.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const ENTRY = join(SRC, 'main.tsx')

/**
 * Ambient declarations and the entry itself export nothing anyone imports.
 *
 * Every `.d.ts`, not just `vite-env`: an ambient `declare module` block is
 * reachable by being in the program at all, never by an import, so "imported
 * by nothing" is the normal and only state for one. The named exemption was
 * the first of them rather than the only kind.
 */
const EXEMPT_MODULES = [/\.d\.ts$/, /main\.tsx$/]
/**
 * A test, or the scaffolding tests are built on. `src/test/` holds the vitest
 * setup file and the shared render helper: neither is reachable from
 * `main.tsx` and neither should be — a render helper that shipped in the
 * bundle would be the actual defect. They are still held to the export rule
 * below, so a helper nothing calls is still reported.
 */
const isTest = f => /\.test\.tsx?$/.test(f) || /[\\/]test[\\/]/.test(f)

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(name) ? [full] : []
  })
}

const files = walk(SRC)
const source = new Map(files.map(f => [f, readFileSync(f, 'utf8')]))
const rel = f => relative(SRC, f).split(sep).join('/')

/* ---------------------------------------------------------------- resolve */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (source.has(candidate)) return candidate
  }
  return null
}

/* ---------------------------------------------------------------- exports */
function exportsOf(text) {
  const names = new Set()
  for (const m of text.matchAll(
    /^export\s+(?:async\s+)?(?:function|const|let|class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1])
  }
  /* `export { a, b as c }` — the exported name is what follows `as`. */
  for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (piece) names.add(piece)
    }
  }
  if (/^export\s+default\b/m.test(text)) names.add('default')
  return names
}

/* ---------------------------------------------------------------- imports */
const importsBySource = new Map() // target file -> Map<name, Set<importer>>
const importedModules = new Map() // target file -> Set<importer>
const graph = new Map() // file -> Set<file>

function note(target, importer, name) {
  if (!importsBySource.has(target)) importsBySource.set(target, new Map())
  const byName = importsBySource.get(target)
  if (!byName.has(name)) byName.set(name, new Set())
  byName.get(name).add(importer)
}

for (const [file, text] of source) {
  graph.set(file, new Set())

  for (const m of text.matchAll(
    /import\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    const target = resolveSpecifier(file, m[2])
    if (!target) continue
    graph.get(file).add(target)
    if (!importedModules.has(target)) importedModules.set(target, new Set())
    importedModules.get(target).add(file)

    const clause = m[1].trim()
    if (/^\*\s+as\s/.test(clause)) {
      /* A namespace import consumes everything the module offers. */
      for (const name of exportsOf(source.get(target))) note(target, file, name)
      continue
    }
    const braces = clause.match(/\{([\s\S]*)\}/)
    const bare = clause.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim()
    if (bare) note(target, file, 'default')
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
        if (name) note(target, file, name)
      }
    }
  }

  /* Bare side-effect imports still keep a module alive. */
  for (const m of text.matchAll(/^import\s*['"]([^'"]+)['"]/gm)) {
    const target = resolveSpecifier(file, m[1])
    if (target) graph.get(file).add(target)
  }

  /* Every route is code-split — `lazy(() => import('./pages/X'))`. Miss these
     and the entire app hangs off nothing and reads as dead. */
  for (const m of text.matchAll(/(?<![\w$.])import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const target = resolveSpecifier(file, m[1])
    if (!target) continue
    graph.get(file).add(target)
    if (!importedModules.has(target)) importedModules.set(target, new Set())
    importedModules.get(target).add(file)
    note(target, file, 'default') // that is what `lazy` unwraps
  }
}

/* ------------------------------------------------- 1. reachable from entry */
const reachable = new Set()
const queue = [ENTRY]
while (queue.length) {
  const file = queue.pop()
  if (reachable.has(file)) continue
  reachable.add(file)
  for (const next of graph.get(file) ?? []) queue.push(next)
}

const islands = files.filter(
  f => !reachable.has(f) && !isTest(f) && !EXEMPT_MODULES.some(re => re.test(f)),
)

/* --------------------------------------------------- 2. exports nobody uses */
const dead = []
const internalOnly = []
const testOnly = []

/** Times the name appears in its own module, beyond the declaration itself. */
function selfUses(text, name) {
  if (name === 'default') return 0
  const re = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g')
  return Math.max(0, [...text.matchAll(re)].length - 1)
}

for (const file of files) {
  if (isTest(file) || EXEMPT_MODULES.some(re => re.test(file))) continue
  if (islands.includes(file)) continue // already reported as a whole
  const text = source.get(file)
  const byName = importsBySource.get(file) ?? new Map()
  for (const name of exportsOf(text)) {
    const consumers = [...(byName.get(name) ?? [])].filter(c => c !== file)
    if (consumers.length === 0) {
      /* Used inside its own module is not dead — the `export` is just wider
         than anything needs. Worth knowing, not worth failing a build over. */
      if (selfUses(text, name) > 0) internalOnly.push({ file, name })
      else dead.push({ file, name })
    } else if (consumers.every(isTest)) {
      testOnly.push({ file, name })
    }
  }
}

/* ------------------------------------------------------------------ report */
const label = ({ file, name }) =>
  `${rel(file)} — ${name === 'default' ? 'default export' : name}`

console.log(`scanned ${files.length} modules under src/\n`)

if (islands.length) {
  console.log('FAIL — not reachable from main.tsx:')
  for (const f of islands) {
    const importers = [...(importedModules.get(f) ?? [])].map(rel)
    console.log(`  ${rel(f)}${importers.length ? `  (imported only by ${importers.join(', ')})` : '  (imported by nothing)'}`)
  }
  console.log('')
} else {
  console.log('ok — every module is reachable from main.tsx')
}

if (dead.length) {
  console.log('FAIL — exported but never imported:')
  for (const d of dead) console.log(`  ${label(d)}`)
  console.log('')
} else {
  console.log('ok — every export has a consumer')
}

if (internalOnly.length) {
  console.log(`note — ${internalOnly.length} exported wider than used (module-internal only):`)
  for (const d of internalOnly) console.log(`  ${label(d)}`)
  console.log('')
}

if (testOnly.length) {
  console.log(`note — ${testOnly.length} exported for a test only:`)
  for (const d of testOnly) console.log(`  ${label(d)}`)
  console.log('')
}

const failed = islands.length + dead.length
console.log(failed ? `${failed} dead ${failed === 1 ? 'thing' : 'things'}` : 'NO DEAD CODE')
process.exit(failed ? 1 : 0)
