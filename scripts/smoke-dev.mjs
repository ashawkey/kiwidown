// Smoke test against the *dev* server. The screenshot harness only exercises the built
// output via `vite preview`, and Vite serves public/ differently in the two modes — this
// catches a base-path or asset-resolution break in `npm run dev` specifically.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5199

const proc = spawn(
  process.execPath,
  [join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'],
  // NO_COLOR: vite colours its banner even when stdout is a pipe, which puts escape codes
  // between "localhost:" and the port — so the line we wait for below never matches.
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } }
)
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('dev server timeout')), 30_000)
  proc.stdout.on('data', (c) => String(c).includes(`:${PORT}`) && (clearTimeout(t), resolve()))
})

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

const problems = []
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
page.on('requestfailed', (r) => problems.push(`failed: ${r.url()}`))
page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.url()}`))

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-app-ready="true"] #write', { timeout: 15_000 })

const checks = await page.evaluate(() => {
  const write = document.getElementById('write')
  const slot = document.getElementById('typora-theme-slot')
  const base = document.getElementById('typora-base-slot')
  // An imported sheet can import more of its own — the built-in themes split structure and
  // palette across two files, and pull in a webfont besides — so count the whole tree. Just
  // reading the entry sheet's length would report 3 for a theme that is a thousand rules,
  // and would go on reporting 3 if everything it imports had failed to load.
  const countRules = (sheet) => {
    if (!sheet) return 0
    let n = 0
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSImportRule) n += countRules(rule.styleSheet)
      else n++
    }
    return n
  }
  const imported = (el) => {
    const rule = el?.sheet?.cssRules?.[0]
    return rule instanceof CSSImportRule ? countRules(rule.styleSheet) : 0
  }
  return {
    themeOptions: document.querySelectorAll('.app-theme-option').length,
    writeChildren: write?.children.length ?? 0,
    baseRules: imported(base),
    themeRules: imported(slot),
    /*
     * Proves the theme actually won the cascade rather than merely loading.
     *
     * This used to compare the page background against white, which stopped meaning
     * anything the moment the default theme became a white one — base.css's own default is
     * also #ffffff, so a completely unstyled page passed. base.css's Helvetica/Arial stack
     * is the better witness: every theme replaces it, and testing that it is *gone* keeps
     * the check from pinning whichever theme happens to be the default.
     */
    themeOverridesBaseFont: !getComputedStyle(write).fontFamily.startsWith('"Helvetica Neue"'),
    bodyBg: getComputedStyle(document.documentElement).backgroundColor,
    taskItems: document.querySelectorAll('li.md-task-list-item').length,
  }
})

console.log(checks)
for (const [k, v] of Object.entries(checks)) {
  if (typeof v === 'number' && v === 0) problems.push(`${k} is 0`)
  if (v === false) problems.push(`${k} is false`)
}

await browser.close()
proc.kill()

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`)
  for (const p of [...new Set(problems)]) console.error(`  ! ${p}`)
  process.exit(1)
}
console.log('\ndev server OK')
process.exit(0)
