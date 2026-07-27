// Measures how much the vendored themes actually use each piece of Typora's DOM.
//
// These numbers are the evidence behind doc/dom-contract.md -- which classes are worth
// emitting, and which of them carry enough weight to be worth a workaround. They are
// deliberately *not* written down anywhere: they change every time a pack is added or
// dropped, and a stale count in a comment is worse than no count, because it reads as
// something that was checked.
//
// Run it when a decision depends on the weight of a selector:
//   npm run themes:stats
//   npm run themes:stats -- --cm      # the CodeMirror token classes specifically
//
// One "selector" is one comma-separated part of one rule's prelude, so `a, b { }` is two.

import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const THEMES = join(ROOT, 'public', 'themes')

/** The proprietary surface: everything a theme can reach for that isn't a plain tag. */
const TOKENS = [
  '#write',
  '.md-diagram',
  'CodeMirror',
  '.md-fences',
  '.cm-s-inner',
  '.md-toc',
  '.md-focus',
  '.code-tooltip',
  '.md-math-block',
  '.md-rawblock',
  '.md-task-list-item',
  '.md-meta',
  '.MathJax',
  '.md-footnote',
  '.md-meta-block',
  '.footnotes',
  '.md-def-footnote',
  '.md-def-name',
  '.md-inline-math',
  '.md-heading',
  '.typora-export',
  '.md-end-block',
  '.ty-cm-lang-input',
  '.md-hr',
  '.ul-list',
  '.ol-list',
]

function stylesheets(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...stylesheets(path))
    else if (entry.name.endsWith('.css')) out.push(path)
  }
  return out
}

/**
 * Every selector in a stylesheet.
 *
 * Comments are stripped first so a commented-out rule isn't counted, and at-rule preludes
 * (`@media`, `@font-face`) are skipped -- only the selectors inside them matter, and those
 * are matched by the same pass since the body of an at-rule contains its own rules.
 */
function selectors(css) {
  const out = []
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const [, prelude] of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const trimmed = prelude.trim()
    if (trimmed.startsWith('@')) continue
    for (const part of trimmed.split(',')) {
      const selector = part.trim()
      if (selector) out.push(selector)
    }
  }
  return out
}

const files = stylesheets(THEMES)
const parsed = files.map((file) => ({ file, selectors: selectors(readFileSync(file, 'utf8')) }))
const { themes } = JSON.parse(readFileSync(join(THEMES, 'index.json'), 'utf8'))

function tally(matches) {
  let uses = 0
  const inFiles = new Set()
  for (const { file, selectors: list } of parsed) {
    for (const selector of list) {
      const n = matches(selector)
      if (n > 0) {
        uses += n
        inFiles.add(file)
      }
    }
  }
  return { uses, files: inFiles, count: inFiles.size }
}

const contains = (token) => (selector) => (selector.includes(token) ? 1 : 0)
/** `.task-list-item` on its own -- not the `.md-task-list-item` that contains it. */
const bareTaskItem = (selector) => (selector.match(/(?<!md-)\.task-list-item/g) ?? []).length
const cmToken = (selector) => (selector.match(/\.cm-(?!s-inner)[a-z0-9-]+/g) ?? []).length

const packs = new Set(themes.map((t) => t.pack))
console.log(
  `${themes.length} themes, ${packs.size} packs, ${files.length} stylesheets — ${[...packs].sort().join(', ')}\n`
)

if (process.argv.includes('--cm')) {
  // Per token class, since that is the question the map in
  // src/editor/code-highlight/token-map.ts actually asks: is this class worth mapping to?
  const perClass = new Map()
  for (const { file, selectors: list } of parsed) {
    for (const selector of list) {
      for (const hit of selector.match(/\.cm-(?!s-inner)[a-z0-9-]+/g) ?? []) {
        if (!perClass.has(hit)) perClass.set(hit, new Set())
        perClass.get(hit).add(file)
      }
    }
  }
  const total = tally(cmToken)
  console.log(`${total.uses} .cm-<token> selectors across ${total.count} stylesheets\n`)
  console.log('  class                 stylesheets')
  for (const [name, inFiles] of [...perClass].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`  ${name.padEnd(22)}${String(inFiles.size).padStart(3)}`)
  }
} else {
  const rows = [
    ...TOKENS.map((token) => [token, tally(contains(token))]),
    ['.task-list-item (bare)', tally(bareTaskItem)],
    ['.cm-<token>', tally(cmToken)],
  ].sort((a, b) => b[1].uses - a[1].uses)

  console.log('  selectors  files  token')
  for (const [name, { uses, count, files: inFiles }] of rows) {
    const where = count > 0 && count <= 2 ? `  (${[...inFiles].map((f) => basename(f)).join(', ')})` : ''
    console.log(`  ${String(uses).padStart(9)}  ${String(count).padStart(5)}  ${name}${where}`)
  }
  console.log('\nRun with --cm for the CodeMirror token classes individually.')
}
