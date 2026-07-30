// Debugging aid, not a check. Two modes:
//
//   node scripts/inspect-dom.mjs [themeId]        dump #write's children with geometry
//   node scripts/inspect-dom.mjs --fence          probe typing inside a code fence
//
// The first tells "the theme didn't apply" apart from "the element rendered but painted
// nothing". The second exists because editing inside a fence has several ways to go wrong
// that all look identical from outside -- the click missing the editable region, the caret
// landing in the wrong block, or the highlighter not rebuilding.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4174

async function selectTheme(page, id) {
  await page.locator('#theme-select').click()
  await page.locator(`.app-theme-option[data-theme-id="${id}"]`).click()
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
  // Without this a held port fails as a timeout thirty seconds later, rather than as the
  // error vite already printed.
  proc.on('exit', (code) => reject(new Error(`vite preview exited with ${code}`)))
})

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.error('pageerror:', String(e)))
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-app-ready="true"] #write')

const arg = process.argv[2]

if (arg === '--fence') {
  // Reproduce what check-contract does first: editing the heading changes the document
  // height, and the reflow is what makes the later fence click unreliable.
  await page.click('#write > h1')
  await page.keyboard.press('End')
  await page.keyboard.type(' EDITED')
  await page.waitForTimeout(150)

  const before = await page.evaluate(() => ({
    text: document.querySelector('#write pre.md-fences > code')?.textContent ?? '',
    tags: document.querySelectorAll('#write pre.md-fences .cm-tag').length,
  }))
  console.log('before:', JSON.stringify(before.text.slice(-60)), `tags=${before.tags}`)

  const target = page.locator('#write pre.md-fences .cm-tag').last()
  console.log('click target text:', JSON.stringify(await target.textContent()))
  console.log('click target box  :', JSON.stringify(await target.boundingBox()))

  await target.click()
  const caret = await page.evaluate(() => {
    const s = getSelection()
    const n = s?.anchorNode
    const active = document.activeElement
    return {
      anchorText: n?.nodeType === 3 ? n.nodeValue?.slice(0, 40) : n?.nodeName,
      offset: s?.anchorOffset,
      inFence: Boolean(n && (n.nodeType === 3 ? n.parentElement : n)?.closest('pre.md-fences')),
      // The selection can survive a blur, so this is the value that decides whether
      // ProseMirror will act on the keystrokes that follow.
      activeElement: active ? `${active.tagName}#${active.id}.${active.className}`.slice(0, 60) : null,
      editorFocused: active?.id === 'write',
    }
  })
  console.log('caret after click :', JSON.stringify(caret))

  await page.keyboard.press('End')
  await page.keyboard.type('\n<aside data-zz="q">hi</aside>')
  await page.waitForTimeout(200)

  const after = await page.evaluate(() => ({
    text: document.querySelector('#write pre.md-fences > code')?.textContent ?? '',
    tags: [...document.querySelectorAll('#write pre.md-fences .cm-tag')].map((e) => e.textContent),
    attrs: [...document.querySelectorAll('#write pre.md-fences .cm-attribute')].map((e) => e.textContent),
    md: window.__kiwidown.getMarkdown().includes('aside'),
  }))
  console.log('after text tail   :', JSON.stringify(after.text.slice(-60)))
  console.log('cm-tag values     :', after.tags.join(','))
  console.log('cm-attribute      :', after.attrs.join(','))
  console.log('markdown has aside:', after.md)
} else {
  if (arg) {
    await selectTheme(page, arg)
    await page.waitForTimeout(1500)
  }
  const { total, out } = await page.evaluate(() => {
    const write = document.getElementById('write')
    const rows = []
    for (const el of write.children) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      rows.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className?.toString().slice(0, 44) ?? '',
        h: Math.round(r.height),
        w: Math.round(r.width),
        display: cs.display,
        vis: cs.visibility,
        op: cs.opacity,
        text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 32),
      })
    }
    return { total: Math.round(write.getBoundingClientRect().height), out: rows }
  })

  const W = [7, 6, 6, 13, 9, 5, 46, 32]
  const pad = (vals) => vals.map((v, i) => String(v).padEnd(W[i])).join('')
  console.log(`#write height: ${total}px, ${out.length} children\n`)
  console.log(pad(['tag', 'h', 'w', 'display', 'vis', 'op', 'class', 'text']))
  for (const r of out) console.log(pad([r.tag, r.h, r.w, r.display, r.vis, r.op, r.cls, r.text]))
}

await browser.close()
proc.kill()
process.exit(0)
