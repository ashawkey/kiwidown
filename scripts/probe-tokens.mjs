// Reports every token chain Prism produces across a spread of languages, and how each one
// maps onto CodeMirror's vocabulary.
//
// This is where src/editor/code-highlight/token-map.ts comes from. The mapping's *targets*
// are dictated by what the vendored themes style; its *sources* have to be whatever Prism
// actually emits, which is not documented anywhere and differs per grammar. Guessing
// produces a map full of entries that never fire and gaps that show up as unstyled code.
//
// Run it after touching the map, or when adding a language:
//   npm run probe:tokens            # summary
//   npm run probe:tokens -- --all   # every chain, including already-mapped ones

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { refractor } from 'refractor'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const showAll = process.argv.includes('--all')

// Deliberately dense samples: the point is to provoke unusual token types, not to be
// realistic. Each one reaches for the constructs its grammar treats specially.
const SAMPLES = {
  javascript: `import fs from 'node:fs'\n// comment\nclass A extends B { #x = 1n; get y() { return \`t\${this.#x}\` } }\nconst re = /ab+c/gi, n = 0x1f, b = true, o = { key: null }\nexport default async function* f(a = 1, ...rest) { await fs?.p ?? 3 }`,
  typescript: `interface P<T extends object> { readonly a?: string | number }\ntype U = keyof P<any>\nenum E { A = 1 }\nconst x = <T,>(v: T): T => v as unknown as T\nnamespace N { export declare const q: bigint }`,
  python: `from os import path as p\n@decorator\nclass C(Base):\n    """doc"""\n    def m(self, *args, **kw) -> int:\n        return len([i for i in range(10) if i % 2])\nf = lambda x: f"{x!r}"`,
  css: `@media (min-width: 30em) { :root { --c: #fff } }\n.a > b#id[attr="v"]::before { color: rgb(1 2 3 / 50%); background: url(x.png) !important }`,
  markup: `<!DOCTYPE html><!-- c --><html lang="en"><body><p id="x" class='y'>t &amp; u</p><script>var a=1</script></body></html>`,
  json: `{"a": [1, -2.5e3, true, null], "b": {"c": "s"}}`,
  rust: `use std::fmt;\n// c\n#[derive(Debug)]\npub struct S<'a> { f: &'a str }\nimpl fmt::Display for S<'_> { fn fmt(&self, x: u32) -> Result<(), E> { let m = 0xFFu8; Ok(()) } }`,
  go: `package main\nimport "fmt"\ntype T struct{ A int }\nfunc (t *T) M(s string) (int, error) { defer f(); go g(); ch := make(chan int); return 0, nil }`,
  java: `package a.b;\nimport java.util.*;\n@Override\npublic final class C<T> extends D implements E { private static final int X = 0; void m() throws Ex { } }`,
  bash: `#!/bin/bash\n# c\nset -euo pipefail\nfor f in *.txt; do echo "\${f%.txt}" | grep -q 'x' && rm -f "$f"; done`,
  sql: `SELECT a.id, COUNT(*) AS n FROM t a JOIN u b ON a.id = b.id WHERE a.x > 1 AND b.y LIKE '%z%' GROUP BY a.id;`,
  yaml: `# c\nkey: value\nlist:\n  - a: 1\n    b: "s"\nanchor: &x\nref: *x`,
  c: `#include <stdio.h>\n/* c */\nstatic const unsigned int N = 0x10;\nint main(int argc, char **argv) { printf("%d\\n", N); return 0; }`,
  ruby: `require 'set'\n# c\nmodule M\n  class C < B\n    def m(a, *r, k: 1)\n      @iv = :sym\n      "#{a}".gsub(/x/) { |m| m.upcase }\n    end\n  end\nend`,
  php: `<?php\nnamespace A;\nuse B\\C;\nclass D extends C { const X = 1; public function m(?string $s): void { echo "$s"; } }`,
  diff: `--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new`,
  markdown: `# h1\n> quote\n**bold** *it* [l](http://x) \`c\`\n- item`,
}

/** Parse the map's source keys straight out of the TypeScript, so the two can't drift. */
function mappedTokenTypes() {
  const src = readFileSync(join(ROOT, 'src/editor/code-highlight/token-map.ts'), 'utf8')
  const body = src.slice(src.indexOf('TOKEN_MAP'), src.indexOf('export function'))
  return new Set([...body.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'[a-z0-9-]+',/gm)].map((m) => m[1]))
}

const mapped = mappedTokenTypes()
const chains = new Map()

function walk(nodes, inherited = []) {
  for (const node of nodes) {
    if (node.type === 'element') {
      walk(node.children, [...inherited, ...(node.properties?.className ?? [])])
    } else if (node.value.trim()) {
      const chain = inherited.filter((c) => c !== 'token')
      if (chain.length) chains.set(chain.join('>'), (chains.get(chain.join('>')) ?? 0) + 1)
    }
  }
}

for (const [lang, code] of Object.entries(SAMPLES)) {
  if (!refractor.registered(lang)) {
    console.warn(`  ! ${lang} is not in the bundled grammar set`)
    continue
  }
  walk(refractor.highlight(code, lang).children)
}

/** Same rule the runtime uses: innermost recognised segment wins. */
function resolve(chain) {
  for (let i = chain.length - 1; i >= 0; i--) if (mapped.has(chain[i])) return chain[i]
  return undefined
}

const rows = [...chains.entries()].sort((a, b) => b[1] - a[1])
const unresolved = []
let covered = 0
let total = 0

for (const [chain, n] of rows) {
  const hit = resolve(chain.split('>'))
  total += n
  if (hit) covered += n
  else unresolved.push([chain, n])
  if (showAll) console.log(`${String(n).padStart(4)}  ${chain.padEnd(58)} ${hit ?? '—'}`)
}

if (!showAll) {
  console.log('Unmapped token chains (these render in the fence body colour):\n')
  for (const [chain, n] of unresolved) console.log(`${String(n).padStart(4)}  ${chain}`)
}

const pct = ((covered / total) * 100).toFixed(1)
console.log(`\n${rows.length} distinct chains across ${Object.keys(SAMPLES).length} languages.`)
console.log(`${covered}/${total} token runs (${pct}%) resolve to a CodeMirror class.`)
console.log(`\nNote: 'punctuation' is unmapped on purpose — CodeMirror leaves it in the body colour.`)
