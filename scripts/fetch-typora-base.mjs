// Vendors the Typora base stylesheet layer.
//
// Source: https://github.com/typora/typora-theme-toolkit — Typora's own toolkit,
// published for theme authors. It ships the real base.css that every community
// theme is written against: the #write box model, task-list layout, footnote
// defaults, and the CodeMirror 5 chrome that .md-fences themes assume exists.
//
// This is a runtime dependency, not a test fixture. src/theme/index.ts imports both
// files into @layer typora-base.vendor on startup, below the theme, so a theme can
// override them — which is what lets community themes be used unmodified.
//
// The toolkit is archived upstream and carries no licence file; see THIRD-PARTY.md.
// Output is committed to the repo, so builds are offline and reproducible whether or
// not this script can still reach GitHub.
//
// Re-run with: npm run base:fetch

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { configureNetwork } from './net.mjs'

configureNetwork()

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = 'https://raw.githubusercontent.com/typora/typora-theme-toolkit/master'

/** @type {Array<{from: string, to: string}>} */
const FILES = [
  // The base layer: #write box model, .typora-export mode, task lists, footnotes.
  { from: 'html-preview/theme/default/base.css', to: 'public/typora-base/base.css' },
  // CodeMirror 5 chrome that .md-fences themes assume exists.
  { from: 'html-preview/theme/default/codemirror.css', to: 'public/typora-base/codemirror.css' },
]

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  return res.text()
}

async function main() {
  for (const { from, to } of FILES) {
    const text = await fetchText(`${RAW}/${from}`)
    const dest = join(ROOT, to)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, text, 'utf8')
    console.log(`  ${to}  (${text.length.toLocaleString()} bytes)`)
  }
  console.log('\nVendored from typora/typora-theme-toolkit.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
