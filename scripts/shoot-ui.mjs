// Viewport screenshots of the chrome, for reviewing the toolbar rather than the document.
//
// shoot-themes.mjs unrolls the scroll container to capture whole documents, which is the
// wrong view for a bar that is deliberately translucent over scrolled content. This keeps
// the real layout and scrolls the document under the glass.
//
//   node scripts/shoot-ui.mjs            # one light theme and one dark one
//   node scripts/shoot-ui.mjs kiwi latex # ids, or substrings of them

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'test', 'shots-ui')
const PORT = 4176

/*
 * Which themes to shoot, resolved against the vendored set before anything starts — so a
 * name that no longer exists fails here and now, rather than as a fifteen-second wait for a
 * stylesheet that is never going to arrive.
 *
 * The default is one light theme and one dark one, taken from the index rather than named
 * here: the chrome has exactly two appearances, switched by [data-theme-dark] on <html>, so
 * a pair is the whole of what there is to review — and re-vendoring the theme set can't
 * leave this pointing at a theme that has gone.
 */
const available = JSON.parse(await readFile(join(ROOT, 'public', 'themes', 'index.json'), 'utf8')).themes
if (!available.length) throw new Error('theme index is empty — run `npm run themes:fetch`')

const themes = process.argv.slice(2).map((wanted) => {
  const match =
    available.find((theme) => theme.id === wanted) ?? available.find((theme) => theme.id.includes(wanted))
  if (!match) {
    throw new Error(`no theme matched "${wanted}". Available:\n  ${available.map((t) => t.id).join('\n  ')}`)
  }
  return match
})
if (!themes.length) {
  for (const dark of [false, true]) {
    const match = available.find((theme) => Boolean(theme.dark) === dark)
    if (match) themes.push(match)
  }
}

const proc = spawn(
  process.execPath,
  [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'],
  // NO_COLOR: vite colours its banner even when stdout is a pipe, which puts escape codes
  // between "localhost:" and the port — so the line we wait for below never matches.
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } }
)
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview timeout')), 30_000)
  proc.stdout.on('data', (c) => String(c).includes(`:${PORT}`) && (clearTimeout(t), resolve()))
})

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 })
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-app-ready="true"] #write')

for (const theme of themes) {
  await page.selectOption('#theme-select', theme.id)
  // Matched on the theme's own path, not on part of its name: several themes in a pack
  // share a prefix, so a looser test resolves against the sheet that is already loaded.
  await page.waitForFunction(
    (href) => {
      const rule = document.getElementById('typora-theme-slot')?.sheet?.cssRules?.[0]
      if (!(rule instanceof CSSImportRule) || !rule.href.endsWith(href)) return false
      return (rule.styleSheet?.cssRules.length ?? 0) > 0
    },
    theme.href,
    { timeout: 15_000 }
  )
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  // Scroll a little so there is real content behind the bar to blur.
  await page.locator('content').evaluate((el) => el.scrollTo(0, 220))
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(OUT, `${theme.id.replace('/', '__')}.png`) })
  console.log(`  ${theme.id.padEnd(24)} ${theme.dark ? 'dark ' : 'light'}`)
}

await browser.close()
proc.kill()
console.log(`\n${themes.length} screenshots → test/shots-ui/`)
process.exit(0)
