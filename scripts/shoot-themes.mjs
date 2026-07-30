// Screenshots the app once per vendored theme, so the whole set can be reviewed at a
// glance instead of clicked through one by one.
//
// This is the check the assertions can't make: check-contract.mjs says the DOM is right,
// the screenshots say it *looks* right, and only the second catches a compat rule that
// quietly breaks layout while every selector still matches.
//
// Uses the locally installed Chrome (no Playwright browser download).
//   npm run themes:shoot             # every theme
//   npm run themes:shoot -- kiwi     # only ids containing "kiwi"

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'test', 'shots')
const PORT = 4173

async function selectTheme(page, id) {
  await page.locator('#theme-select').click()
  await page.locator(`.app-theme-option[data-theme-id="${id}"]`).click()
}
const VIEWPORT = { width: 1280, height: 900 }

const filter = process.argv[2]

function startPreview() {
  // Run vite's binary directly rather than through `npx ... --shell`: on Windows,
  // killing a shell-wrapped spawn kills only the shell, orphaning the server and
  // leaving the strict port held for the next run.
  const bin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  const proc = spawn(process.execPath, [bin, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Vite colours its banner even when stdout is a pipe, which puts escape codes between
    // "localhost:" and the port — so the line we wait for below never matches.
    env: { ...process.env, NO_COLOR: '1' },
  })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite preview did not start in 30s')), 30_000)
    proc.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`:${PORT}`)) {
        clearTimeout(timer)
        resolve()
      }
    })
    proc.on('exit', (code) => reject(new Error(`vite preview exited with ${code}`)))
  })
  return { proc, ready }
}

async function main() {
  const { themes } = JSON.parse(await readFile(join(ROOT, 'public', 'themes', 'index.json'), 'utf8'))
  const wanted = filter ? themes.filter((t) => t.id.includes(filter)) : themes
  if (wanted.length === 0) throw new Error(`no themes matched "${filter}"`)

  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  const preview = startPreview()
  let browser
  try {
    await preview.ready
    browser = await chromium.launch({ channel: 'chrome' })
    await shoot(browser, wanted)
  } finally {
    // Always tear down: a leaked preview server holds the strict port and makes the
    // next run fail with an unrelated error.
    await browser?.close()
    preview.proc.kill()
  }
  console.log(`\n${wanted.length} screenshots → test/shots/`)
  // Playwright and vite both leave handles that can keep the loop alive on Windows.
  process.exit(0)
}

async function shoot(browser, wanted) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })

  /** Console errors and failed requests, attributed to whichever theme was active. */
  let current = ''
  const problems = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`${current}: console ${msg.text()}`)
  })
  page.on('requestfailed', (req) => {
    problems.push(`${current}: failed ${req.url()} (${req.failure()?.errorText})`)
  })
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`${current}: HTTP ${res.status()} ${res.url()}`)
  })

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-app-ready="true"] #write', { timeout: 15_000 })

  // Capture whole documents, not just the first screen — the constructs most likely to
  // break (tables, fences, task lists, footnotes) all live below the fold. An element
  // screenshot of #write can't reach them: it's clipped by <content>'s scroll, so
  // everything past one viewport comes back blank. Unroll that inner scroll into normal
  // page flow instead, so fullPage has something to capture. In @layer app so it
  // outranks whichever theme is loaded.
  await page.addStyleTag({
    content: `@layer app {
      #app { height: auto; }
      .app-stage { min-height: 0; }
      content { height: auto; overflow: visible; }
    }`,
  })

  for (const theme of wanted) {
    current = theme.id
    await selectTheme(page, theme.id)
    // The theme arrives via @import, so wait for it to be fetched and parsed rather
    // than trusting a fixed delay. An imported sheet is not a top-level entry in
    // document.styleSheets — it hangs off the slot's own CSSImportRule, and its
    // .styleSheet stays null until the import resolves.
    await page.waitForFunction(
      (href) => {
        const slot = document.getElementById('typora-theme-slot')
        const rule = slot?.sheet?.cssRules?.[0]
        if (!(rule instanceof CSSImportRule) || !rule.href.endsWith(href)) return false
        return (rule.styleSheet?.cssRules.length ?? 0) > 0
      },
      theme.href,
      { timeout: 15_000 }
    )
    await page.evaluate(async () => {
      await document.fonts.ready
    })

    const file = join(OUT, `${theme.id.replace('/', '__')}.png`)
    await page.screenshot({ path: file, fullPage: true })
    console.log(`  ${theme.id.padEnd(24)} ${theme.dark ? 'dark ' : 'light'}  ${theme.name}`)
  }

  if (problems.length > 0) {
    console.warn(`\n${problems.length} problem(s):`)
    for (const p of [...new Set(problems)]) console.warn(`  ! ${p}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
