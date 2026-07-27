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
  const imported = (el) => {
    const rule = el?.sheet?.cssRules?.[0]
    return rule instanceof CSSImportRule ? (rule.styleSheet?.cssRules.length ?? 0) : 0
  }
  return {
    themeOptions: document.querySelectorAll('#theme-select option').length,
    writeChildren: write?.children.length ?? 0,
    baseRules: imported(base),
    themeRules: imported(slot),
    // Proves the theme actually won the cascade rather than merely loading.
    bodyBg: getComputedStyle(document.documentElement).backgroundColor,
    taskItems: document.querySelectorAll('li.md-task-list-item').length,
  }
})

console.log(checks)
for (const [k, v] of Object.entries(checks)) {
  if (typeof v === 'number' && v === 0) problems.push(`${k} is 0`)
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
