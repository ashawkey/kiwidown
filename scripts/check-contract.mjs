// Asserts that the editor emits the DOM described in doc/dom-contract.md.
//
// This is the main regression net. Themes are stylesheets written against a specific DOM,
// so "does it still look right" ultimately reduces to "does it still emit the right
// elements and classes" -- and that is a question a machine can answer, unlike the
// screenshots, which need eyes.
//
// Each check names the selector it asserts and, where the requirement isn't obvious, the
// theme rule that depends on it.
//
//   npm run check:contract

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4175

/**
 * @type {Array<{ what: string, selector: string, min?: number, why?: string }>}
 */
const CHECKS = [
  { what: 'editor root', selector: '#write.ProseMirror', why: 'themes scope everything to #write' },
  {
    what: '#write holds blocks directly',
    selector: '#write > p',
    why: 'themes use direct-child selectors like `#write > h3.md-focus:before`',
  },
  { what: 'headings', selector: '#write > h1.md-heading', why: 'latex hangs its heading numbering off .md-heading' },
  { what: 'heading levels', selector: '#write h2.md-heading, #write h3.md-heading', min: 2 },
  { what: 'paragraphs', selector: '#write > p.md-end-block' },
  { what: 'blockquote', selector: '#write > blockquote.md-end-block' },
  { what: 'thematic break', selector: '#write > hr.md-hr' },
  {
    what: 'bullet list',
    selector: '#write ul.ul-list',
    why: 'Typora emits it; no vendored theme keys off it today, but the contract is Typora\'s DOM',
  },
  { what: 'ordered list', selector: '#write ol.ol-list' },
  { what: 'table', selector: '#write table' },
  { what: 'table cells', selector: '#write table td', min: 3 },
  {
    what: 'code fence',
    selector: '#write pre.md-fences.cm-s-inner',
    why: '.md-fences + .cm-* -- the largest proprietary surface in the theme set',
  },
  { what: 'code fence inner <code>', selector: '#write pre.md-fences > code' },
  {
    what: 'fence tokens use CodeMirror names',
    selector: '#write pre.md-fences.cm-s-inner .cm-tag',
    min: 3,
    why: 'themes colour code through `.cm-s-inner .cm-*`',
  },
  { what: 'fence keyword tokens', selector: '#write pre.md-fences .cm-keyword' },
  { what: 'fence string tokens', selector: '#write pre.md-fences .cm-string' },
  { what: 'fence number tokens', selector: '#write pre.md-fences .cm-number' },
  {
    what: 'fence tokens keep Prism names too',
    selector: '#write pre.md-fences .token.cm-tag',
    min: 3,
    why: 'so a Prism stylesheet would also work here',
  },
  {
    what: 'task item classes',
    selector: '#write li.task-list-item.md-task-list-item',
    min: 2,
    why: 'base.css keys layout off md-task-list-item; some themes target bare task-list-item',
  },
  { what: 'task item checked state', selector: '#write li.md-task-list-item.task-list-done' },
  { what: 'task item unchecked state', selector: '#write li.md-task-list-item.task-list-not-done' },
  {
    what: 'task checkbox is a direct child of <li>',
    selector: '#write li.md-task-list-item > input[type=checkbox]',
    min: 2,
    why: 'base.css positions it with `.md-task-list-item > input`',
  },
  { what: 'checked box reflects state', selector: '#write li.task-list-done > input:checked' },
  { what: 'footnote reference', selector: '#write sup.md-footnote' },
  {
    what: 'footnote definition',
    selector: '#write div.footnotes.md-def-footnote',
    why: 'themes style .footnotes and .md-def-footnote directly',
  },
  {
    what: 'footnote label',
    selector: '#write .md-def-footnote > span.md-def-name',
    why: 'latex brackets it with .md-def-name:before/:after',
  },
  { what: 'footnote body', selector: '#write .md-def-footnote .md-def-content' },
  {
    what: 'YAML front matter',
    selector: '#write > pre.md-meta-block',
    why: 'without it remark reads the closing --- as a setext underline and makes an <h2>',
  },
  { what: 'highlight ==x==', selector: '#write mark' },
  { what: 'superscript X^2^', selector: '#write sup:not(.md-footnote)' },
  { what: 'subscript H~2~O', selector: '#write sub' },
  {
    what: 'inline math container',
    selector: '#write .md-inline-math',
    why: 'themes place formulas through .md-math-block / .md-inline-math',
  },
  { what: 'math rendered by KaTeX', selector: '#write .md-inline-math .katex' },
  {
    what: 'display math block',
    selector: '#write .md-math-block.md-rawblock',
    why: 'themes centre and space formulas through .md-math-block, not .md-inline-math',
  },
  {
    what: 'diagram fence',
    selector: '#write pre.md-fences.md-diagram',
    why: '.md-diagram is one of the heaviest selectors in the theme set',
  },
  { what: 'diagram preview panel', selector: '#write .md-diagram-panel > .md-diagram-panel-preview' },
  { what: '[TOC] block', selector: '#write div.md-toc', why: 'nearly every theme styles .md-toc' },
  { what: 'TOC entries', selector: '#write .md-toc .md-toc-item > a.md-toc-inner', min: 5 },
  {
    what: 'TOC entries carry an anchor',
    selector: '#write .md-toc a.md-toc-inner[href^="#"]',
    min: 5,
    why: 'heading.attrs.id is always empty; the anchor has to come from headingIdGenerator',
  },
  { what: 'TOC entry levels', selector: '#write .md-toc .md-toc-h1, #write .md-toc .md-toc-h3', min: 2 },
  { what: 'link', selector: '#write a[href]', min: 2 },
  { what: 'emphasis', selector: '#write em' },
  { what: 'strong', selector: '#write strong' },
  { what: 'inline code', selector: '#write code' },
  { what: 'image', selector: '#write img' },
]

/**
 * Poll `probe` in the page until every value it returns is truthy, then return them.
 *
 * Editing checks would otherwise race: ProseMirror applies a transaction, rebuilds
 * decorations and re-renders over several frames, so any fixed delay is either flaky or
 * needlessly slow. Returns the last reading either way, so a genuine failure still reports
 * which parts were false rather than just timing out.
 */
async function settled(page, probe, timeout = 5_000) {
  const deadline = Date.now() + timeout
  let last
  do {
    last = await page.evaluate(probe)
    if (Object.values(last).every(Boolean)) return last
    await page.waitForTimeout(50)
  } while (Date.now() < deadline)
  return last
}

/**
 * Run an editor interaction until `probe` reports success, retrying the whole thing.
 *
 * Driving a rich-text editor through synthetic input is inherently racy: Playwright
 * scrolls the target into view, measures it, then clicks the centre of that box -- and
 * these checks have usually just changed the document height, so a reflow between measure
 * and click can put the pointer somewhere harmless. The keystrokes that follow then go
 * nowhere, and the check fails while the feature it is testing works fine.
 *
 * Retrying the interaction, rather than sleeping longer before it, is what makes this
 * deterministic. Probes are written to tolerate re-running (they test for presence, not
 * counts), so a second attempt after a partial first is still correct.
 */
async function interact(page, act, probe, attempts = 3) {
  let last
  for (let i = 0; i < attempts; i++) {
    await act()
    last = await settled(page, probe, 2_000)
    if (Object.values(last).every(Boolean)) return last
  }
  return last
}

/**
 * Wait for the server by asking it, rather than by reading its log.
 *
 * Vite writes the URL with ANSI colour codes *inside* it — `localhost:` then an escape
 * sequence, then the port — so watching stdout for `:PORT` never matches on a terminal
 * that supports colour, and the whole check times out before it has run anything.
 */
async function waitForServer(url, timeout = 30_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`${url} did not come up in ${timeout / 1000}s`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function startPreview() {
  const bin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  const proc = spawn(process.execPath, [bin, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ready = Promise.race([
    waitForServer(`http://localhost:${PORT}/`),
    new Promise((_, reject) =>
      proc.on('exit', (code) => reject(new Error(`vite preview exited with ${code}`)))
    ),
  ])
  return { proc, ready }
}

async function run(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-app-ready="true"] #write', { timeout: 15_000 })

  const results = await page.evaluate(
    (checks) => checks.map((c) => ({ ...c, found: document.querySelectorAll(c.selector).length })),
    CHECKS
  )

  /*
   * Every check is counted here and nowhere else.
   *
   * The total used to be `results.length + <a number typed by hand>`, which drifted the
   * moment a check was added and quietly under-reported how much was being asserted.
   */
  let failed = 0
  let checks = 0
  /** Count one check and its outcome. Returns `ok`, so it can wrap a condition inline. */
  const tally = (ok) => {
    checks++
    if (!ok) failed++
    return ok
  }

  for (const r of results) {
    const need = r.min ?? 1
    const ok = tally(r.found >= need)
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${r.what.padEnd(38)} ${String(r.found).padStart(3)}/${need}  ${r.selector}`
    )
    if (!ok && r.why) console.log(`        -> ${r.why}`)
  }

  // .md-focus is selection-driven, so it needs the editor focused to be observable.
  await page.click('#write > h1')
  await page.waitForTimeout(150)
  const focus = await page.evaluate(() => ({
    focused: document.querySelectorAll('#write .md-focus, #write.md-focus').length,
    onHeading: document.querySelectorAll('#write > h1.md-focus').length,
  }))
  const focusOk = focus.onHeading >= 1
  tally(focusOk)
  console.log(
    `  ${focusOk ? 'PASS' : 'FAIL'}  ${'.md-focus follows the caret'.padEnd(38)} ${String(focus.onHeading).padStart(3)}/1  #write > h1.md-focus`
  )
  if (!focusOk) console.log('        -> .md-focus is what themes hang their editing affordances off')

  // A TOC entry has to point at a heading that exists. The ids come from Milkdown's
  // headingIdGenerator rather than from `heading.attrs.id`, which is empty for anything
  // parsed from Markdown -- reading the attribute gave every entry an empty anchor and a
  // click handler that asked the document for `#`, which throws. Clicking one here is what
  // catches that: the exception would land in consoleErrors and fail the run.
  const tocLinks = await page.evaluate(() => {
    const links = [...document.querySelectorAll('#write .md-toc a.md-toc-inner')]
    return {
      anchored: links.length > 0 && links.every((a) => (a.getAttribute('href') ?? '').length > 1),
      resolve: links.every((a) => document.querySelector(`#write ${a.getAttribute('href')}`) !== null),
    }
  })
  await page.click('#write .md-toc a.md-toc-inner')
  await page.waitForTimeout(100)
  // The link sits in a contenteditable=false node view, so clicking it takes DOM focus off
  // the editor -- and the plugins that key on focus (md-meta, md-focus) go quiet until it
  // comes back. Put it back, so the checks below start from the state they expect.
  await page.click('#write > h1')
  await page.waitForTimeout(100)
  const tocOk = Object.values(tocLinks).every(Boolean)
  tally(tocOk)
  console.log(`  ${tocOk ? 'PASS' : 'FAIL'}  ${'TOC entries resolve to their headings'.padEnd(38)}`)
  if (!tocOk) console.log(`        -> ${JSON.stringify(tocLinks)}`)

  // Markdown is the source of truth, so a document that survives a load/serialise cycle
  // matters as much as the DOM.
  //
  // Compared modulo the delimiter choices remark normalises on the way out -- these are
  // spelling, not content, and CommonMark treats each pair as identical:
  //   list markers        `+ x`   -> `* x`
  //   emphasis            `_em_`  -> `*em*`
  //   thematic breaks     `----`  -> `***`
  //   escapes             `~`     -> `\~`
  //   autolinks           `https://x` -> `<https://x>`
  // Anything beyond that is real corruption and should fail.
  //
  // The escaping is remark-gfm declaring `~` unsafe in phrasing content, so a tilde that
  // isn't part of a subscript comes back escaped. It renders identically and re-parses to
  // the same tree, so it's spelling -- but only if it's *stable*, hence the second
  // round-trip below. An editor that added a backslash on every save would be broken.
  const trip = await page.evaluate(() => {
    const hook = window.__kiwidown
    const normalise = (md) =>
      md
        .replace(/\r\n/g, '\n')
        .replace(/^([ \t]*)[-+*] /gm, '$1* ')
        .replace(/_([^_\n]+)_/g, '*$1*')
        .replace(/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/gm, '---')
        .replace(/\\([^\w\s])/g, '$1')
        .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
    return { source: normalise(hook.source), round: normalise(hook.getMarkdown()) }
  })
  const tripOk = trip.source === trip.round
  tally(tripOk)
  console.log(`  ${tripOk ? 'PASS' : 'FAIL'}  ${'Markdown round-trips'.padEnd(38)}`)
  if (!tripOk) {
    for (let i = 0; i < Math.max(trip.source.length, trip.round.length); i++) {
      if (trip.source[i] !== trip.round[i]) {
        console.log(`        -> diverges at ${i}:`)
        console.log(`          in:  ...${trip.source.slice(Math.max(0, i - 40), i + 60)}`)
        console.log(`          out: ...${trip.round.slice(Math.max(0, i - 40), i + 60)}`)
        break
      }
    }
  }

  // Classes existing is not the same as the theme reaching them. Compare a token's colour
  // against the fence body's: if the theme's `.cm-s-inner .cm-*` rules are landing, they
  // differ. This is what would catch the whole mapping being right but, say, `.cm-s-inner`
  // ending up on the wrong element.
  const colours = await page.evaluate(() => {
    const fence = document.querySelector('#write pre.md-fences')
    const body = fence && getComputedStyle(fence).color
    const sample = (sel) => {
      const el = document.querySelector(`#write pre.md-fences ${sel}`)
      return el ? getComputedStyle(el).color : null
    }
    return { body, tag: sample('.cm-tag'), keyword: sample('.cm-keyword'), number: sample('.cm-number') }
  })
  const themed = ['tag', 'keyword', 'number'].filter((k) => colours[k] && colours[k] !== colours.body)
  const coloursOk = themed.length >= 2
  tally(coloursOk)
  console.log(
    `  ${coloursOk ? 'PASS' : 'FAIL'}  ${'theme actually colours fence tokens'.padEnd(38)} ${themed.length}/3 differ from body`
  )
  if (!coloursOk) console.log(`        -> ${JSON.stringify(colours)}`)

  // Syntax markers: Typora reveals the delimiters around whatever the caret is inside, and
  // only those -- other bold words in the same paragraph stay rendered. Driven by placing
  // the selection directly, since the property under test is about which mark the caret is
  // in, not about hitting a target with the mouse.
  const putCursorInStrong = () =>
    page.evaluate(() => {
      window.__kiwidown.withView((view) => {
        const { state } = view
        let inside = null
        state.doc.descendants((node, pos) => {
          if (inside === null && node.isText && node.marks.some((m) => m.type.name === 'strong')) {
            // Land in the middle of the run, so the caret is unambiguously inside it.
            inside = pos + Math.ceil(node.nodeSize / 2)
          }
          return inside === null
        })
        if (inside === null) throw new Error('no strong text in the reference document')
        // TextSelection reached through the live selection's constructor -- the class isn't
        // exported to the page, and this avoids widening the test hook to carry it.
        const TextSelection = state.selection.constructor
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, inside)))
        view.focus()
      })
    })

  await putCursorInStrong()
  // Only the markers synthesised around inline marks are under test here. A `$$` block
  // keeps its own `.md-meta` delimiters in the DOM permanently -- they belong to the node
  // view, not to the caret, and are hidden by CSS until the block is focused -- so
  // counting every `.md-meta` in the document would report them as stray and invisible.
  // Defined inside each probe rather than shared: probes are serialised into the page and
  // cannot close over anything here.
  const markers = await settled(page, () => {
    const inline = [...document.querySelectorAll('#write .md-meta')].filter(
      (e) => !e.closest('.md-math-block')
    )
    const metas = inline.map((e) => e.textContent)
    return {
      shown: metas.includes('**'),
      // Opening and closing, and nothing else revealed: the emphasis and code spans
      // elsewhere in the same paragraph must stay rendered.
      paired: metas.filter((t) => t === '**').length === 2,
      scoped: metas.every((t) => t === '**'),
      visible: inline.every((e) => getComputedStyle(e).display !== 'none'),
    }
  })
  const markersOk = Object.values(markers).every(Boolean)
  tally(markersOk)
  console.log(`  ${markersOk ? 'PASS' : 'FAIL'}  ${'syntax markers reveal on focus'.padEnd(38)}`)
  if (!markersOk) console.log(`        -> ${JSON.stringify(markers)}`)

  // …and disappear again when focus leaves.
  await page.evaluate(() => window.__kiwidown.withView((view) => view.dom.blur()))
  const cleared = await settled(page, () => ({
    hidden:
      [...document.querySelectorAll('#write .md-meta')].filter((e) => !e.closest('.md-math-block'))
        .length === 0,
  }))
  tally(cleared.hidden)
  console.log(`  ${cleared.hidden ? 'PASS' : 'FAIL'}  ${'markers clear on blur'.padEnd(38)}`)

  // The welcome document ends with a diagram, so this asserts against what actually
  // loaded rather than swapping in a document of its own. Only the SVG is awaited: the
  // fence and panel are built synchronously by the node view and are in CHECKS above,
  // while Mermaid itself is fetched on demand and then renders asynchronously.
  const mermaidResult = await settled(
    page,
    () => {
      const panel = document.querySelector('#write pre.md-diagram .md-diagram-panel-preview')
      return {
        svg: Boolean(panel?.querySelector('svg')),
        // Themes reach into Mermaid's own SVG classes through the preview, so the SVG has
        // to be Mermaid's, not a placeholder.
        rendered: (panel?.querySelector('svg')?.textContent ?? '').includes('Markdown'),
      }
    },
    15_000
  )
  const mermaidOk = Object.values(mermaidResult).every(Boolean)
  tally(mermaidOk)
  console.log(`  ${mermaidOk ? 'PASS' : 'FAIL'}  ${'mermaid fence renders a diagram'.padEnd(38)}`)
  if (!mermaidOk) console.log(`        -> ${JSON.stringify(mermaidResult)}`)

  // Rendering a diagram must not consume its source. The round-trip check above compares
  // the whole document, but it would still pass if the fence and its language were both
  // dropped, so name them here.
  const diagramTrip = await page.evaluate(() => ({
    kept: window.__kiwidown.getMarkdown().includes('graph LR'),
    fenced: window.__kiwidown.getMarkdown().includes('```mermaid'),
  }))
  const diagramTripOk = diagramTrip.kept && diagramTrip.fenced
  tally(diagramTripOk)
  console.log(`  ${diagramTripOk ? 'PASS' : 'FAIL'}  ${'diagram source round-trips'.padEnd(38)}`)
  if (!diagramTripOk) console.log(`        -> ${JSON.stringify(diagramTrip)}`)

  // Serialisation must be a fixed point. Normalisation is fine once; normalisation that
  // compounds would rewrite the user's file a little more on every save.
  const stable = await page.evaluate(() => {
    const first = window.__kiwidown.getMarkdown()
    return { first, second: window.__kiwidown.getMarkdown(), same: first === window.__kiwidown.getMarkdown() }
  })
  tally(stable.same)
  console.log(`  ${stable.same ? 'PASS' : 'FAIL'}  ${'serialisation is stable'.padEnd(38)}`)

  // It has to actually be an editor, not just a rendered document.
  //
  // Waiting on the expected state rather than a fixed delay: ProseMirror applies the
  // transaction, rebuilds decorations and re-renders across several frames, and a sleep
  // long enough to be reliable on a loaded machine is far longer than it usually needs.
  const edit = await interact(
    page,
    async () => {
      await page.click('#write > h1')
      await page.keyboard.press('End')
      await page.keyboard.type(' EDITED')
    },
    () => ({
      dom: document.querySelector('#write > h1')?.textContent.includes('EDITED') ?? false,
      md: window.__kiwidown.getMarkdown().includes('# Welcome to Kiwidown EDITED'),
    })
  )
  const editOk = edit.dom && edit.md
  tally(editOk)
  console.log(`  ${editOk ? 'PASS' : 'FAIL'}  ${'typing updates DOM and Markdown'.padEnd(38)}`)
  if (!editOk) console.log(`        -> dom: ${JSON.stringify(edit.dom)}  md: ${JSON.stringify(edit.md)}`)

  // Highlighting has to survive editing, not just initial load -- the decorations are
  // rebuilt on every document change, and a stale or misaligned rebuild is the most likely
  // way this breaks.
  // The welcome document's first fence is tagged `html`, so the probe has to be markup --
  // typing JS here would land in HTML text content and correctly not be highlighted. The
  // diagram further down is a code_block too, which is why the html fence comes first.
  // The change is applied as a transaction rather than by clicking into the fence and
  // typing. Driving this through synthetic input meant aiming at an eight-pixel token span
  // in a document whose height had just changed, which failed unpredictably and, when it
  // failed, was testing Playwright rather than the highlighter. Real keyboard input is
  // still covered by the heading check above; what matters here is that a document change
  // rebuilds the decorations at the right positions.
  await page.evaluate(() => {
    window.__kiwidown.withView((view) => {
      const { state } = view
      let target = null
      state.doc.descendants((node, pos) => {
        if (target || node.type.name !== 'code_block') return !target
        target = { node, pos }
        return false
      })
      if (!target) throw new Error('no code_block in the document')
      const endOfCode = target.pos + 1 + target.node.content.size
      view.dispatch(state.tr.insertText('\n<aside data-zz="q">hi</aside>', endOfCode))
    })
  })
  const reHighlight = await settled(page, () => {
    const text = (sel) =>
      [...document.querySelectorAll(`#write pre.md-fences ${sel}`)].map((e) => e.textContent)
    return {
      tag: text('.cm-tag').includes('aside'),
      attribute: text('.cm-attribute').includes('data-zz'),
      inMarkdown: window.__kiwidown.getMarkdown().includes('<aside data-zz="q">hi</aside>'),
    }
  })
  const reOk = reHighlight.tag && reHighlight.attribute && reHighlight.inMarkdown
  tally(reOk)
  console.log(`  ${reOk ? 'PASS' : 'FAIL'}  ${'typed code is re-highlighted'.padEnd(38)}`)
  if (!reOk) console.log(`        -> ${JSON.stringify(reHighlight)}`)

  // An empty document must still be obviously writable: clicking the blank space below it
  // has to focus the editor and put a caret somewhere, or there is nothing to aim at.
  await page.evaluate(() => {
    window.__kiwidown.setMarkdown('')
    window.__kiwidown.withView((view) => view.dom.blur())
  })
  const box = await page.locator('.app-stage').boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 60)
  const emptyClick = await settled(page, () => ({
    focused: document.activeElement?.id === 'write',
    caret: (getSelection()?.rangeCount ?? 0) > 0,
    inEditor: Boolean(
      getSelection()?.anchorNode &&
        (getSelection().anchorNode.nodeType === 3
          ? getSelection().anchorNode.parentElement
          : getSelection().anchorNode
        )?.closest('#write')
    ),
  }))
  const emptyOk = Object.values(emptyClick).every(Boolean)
  tally(emptyOk)
  console.log(`  ${emptyOk ? 'PASS' : 'FAIL'}  ${'clicking blank space starts writing'.padEnd(38)}`)
  if (!emptyOk) console.log(`        -> ${JSON.stringify(emptyClick)}`)

  // --- documents -----------------------------------------------------------------
  // The file pickers can't be driven headlessly (they're a browser-native dialog), so
  // these cover everything around them: dirty tracking, the autosave buffer, and loading.
  //
  // Makes its own edit rather than inheriting one from the checks above.
  //
  // Milkdown's listener debounces markdownUpdated by 200ms and skips transactions that
  // don't pass its guard, so whether the store has heard about an edit made by an earlier
  // check is a timing question, not a property worth asserting -- and it is not the
  // property under test. Driving the store off a side effect five checks away is also what
  // made this fail when an unrelated `setMarkdown` was removed from the diagram check,
  // while the behaviour itself was fine: typing marks a document dirty, including after a
  // blur or a click on the chrome.
  //
  // The check above left the caret in the (now empty) document, so this types straight in.
  await page.keyboard.type('dirty')
  const docState = await settled(page, () => {
    const store = window.__kiwidown.store
    return {
      dirty: store.state.dirty,
      // The unsaved marker sits on the tab, not on the name field inside it.
      marker: Boolean(document.querySelector('.app-doc-tab.is-dirty')),
      autosaved: Boolean(localStorage.getItem('kiwidown.draft')),
    }
  })
  const docOk = Object.values(docState).every(Boolean)
  tally(docOk)
  console.log(`  ${docOk ? 'PASS' : 'FAIL'}  ${'edits mark dirty and autosave'.padEnd(38)}`)
  if (!docOk) console.log(`        -> ${JSON.stringify(docState)}`)

  // Loading a document clears the dirty state and the recovery buffer along with it.
  const afterLoad = await page.evaluate(() => {
    window.__kiwidown.store.load('# fresh\n', 'fresh.md')
    return {
      clean: window.__kiwidown.store.state.dirty === false,
      named: window.__kiwidown.store.state.name === 'fresh.md',
      draftCleared: localStorage.getItem('kiwidown.draft') === null,
      content: window.__kiwidown.getMarkdown().includes('# fresh'),
    }
  })
  const loadOk = Object.values(afterLoad).every(Boolean)
  tally(loadOk)
  console.log(`  ${loadOk ? 'PASS' : 'FAIL'}  ${'loading a document resets state'.padEnd(38)}`)
  if (!loadOk) console.log(`        -> ${JSON.stringify(afterLoad)}`)

  // ?src= fetches and adopts a remote document. Pointed at a file we know is served, so
  // this exercises fetch, naming and load rather than any particular content.
  await page.goto(`http://localhost:${PORT}/?src=${encodeURIComponent('./themes/index.json')}`, {
    waitUntil: 'networkidle',
  })
  await page.waitForSelector('[data-app-ready="true"] #write', { timeout: 15_000 })
  const fromUrl = await settled(page, () => ({
    // The document name is an editable field, so its value is what's displayed.
    named: document.querySelector('.app-doc-name')?.value === 'index.json',
    loaded: window.__kiwidown.getMarkdown().includes('themes'),
  }))
  const urlOk = Object.values(fromUrl).every(Boolean)
  tally(urlOk)
  console.log(`  ${urlOk ? 'PASS' : 'FAIL'}  ${'?src= loads a remote document'.padEnd(38)}`)
  if (!urlOk) console.log(`        -> ${JSON.stringify(fromUrl)}`)

  // --- writing blocks that have no syntax left ------------------------------------
  //
  // A WYSIWYG editor eats the syntax that created a block: the ``` line that named a
  // fence's language and the `$$` that opened a formula are both consumed, so without
  // something to put in their place those blocks can be created and then never changed.
  // These cover both halves — opening the block, and editing it afterwards.

  /** One line of output per check, in the same shape as the rest of this script. */
  const record = (what, result, why) => {
    const ok = Object.values(result).every(Boolean)
    tally(ok)
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what.padEnd(38)}`)
    if (!ok) {
      console.log(`        -> ${JSON.stringify(result)}`)
      if (why) console.log(`        -> ${why}`)
    }
  }

  // Typing is driven from the caret rather than from a click, for the reason given above
  // the highlighting check: aiming at a moving target is testing Playwright, not the
  // editor. Clicks appear below only where the click itself is what's under test.
  const startTyping = async (markdown) => {
    await page.evaluate((md) => {
      window.__kiwidown.setMarkdown(md)
      window.__kiwidown.withView((view) => {
        const { state } = view
        const TextSelection = state.selection.constructor
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)))
        view.focus()
      })
    }, markdown)
    await page.waitForTimeout(100)
  }

  await startTyping('# probe\n\ntext\n')
  await page.keyboard.press('Enter')
  await page.keyboard.type('$$')
  await page.keyboard.press('Enter')
  await page.keyboard.type('E = mc^2')
  record(
    '$$ + Enter opens a formula',
    await settled(page, () => ({
      block: Boolean(document.querySelector('#write .md-math-block.md-rawblock')),
      source:
        document.querySelector('#write .md-math-block .md-rawblock-input')?.textContent === 'E = mc^2',
      katex: Boolean(document.querySelector('#write .md-math-block .md-rawblock-container .katex')),
      markdown: /\$\$\s*\nE = mc\^2\s*\n\$\$/.test(window.__kiwidown.getMarkdown()),
    })),
    'themes place the formula through .md-math-block; the source is .md-rawblock-input, as in Typora'
  )

  // The source is revealed by the caret and nothing else, so the rendered formula has to
  // be clickable — it is the only thing on screen when the block is not focused.
  await page.click('#write > h1')
  const mathAway = await settled(page, () => ({
    hidden:
      getComputedStyle(document.querySelector('#write .md-math-block .md-rawblock-input')).display ===
      'none',
  }))
  await page.click('#write .md-math-block .md-rawblock-container')
  const mathBack = await settled(page, () => ({
    shown:
      getComputedStyle(document.querySelector('#write .md-math-block .md-rawblock-input')).display !==
      'none',
  }))
  record('formula source follows the caret', { ...mathAway, ...mathBack })

  // Inline maths, and the caret-eating hazard behind it: `^` closes a superscript before
  // the formula closes, so the rule has to reconstruct its own source.
  await startTyping('# probe\n\nstart\n')
  await page.keyboard.type(' $a^2+b^2$')
  record(
    '$x$ becomes inline maths as typed',
    await settled(page, () => ({
      katex: Boolean(document.querySelector('#write .md-inline-math .katex')),
      markdown: window.__kiwidown.getMarkdown().includes('$a^2+b^2$'),
    }))
  )

  await page.click('#write .md-inline-math')
  const mathInlineOpen = await settled(page, () => ({
    source: document.querySelector('#write .md-inline-math .md-content')?.textContent === 'a^2+b^2',
  }))
  await page.keyboard.type('+c')
  const mathInlineEdit = await settled(page, () => ({
    edited: window.__kiwidown.getMarkdown().includes('$a^2+b^2+c$'),
  }))
  await page.keyboard.press('Escape')
  const mathInlineDone = await settled(page, () => ({
    rerendered: Boolean(document.querySelector('#write .md-inline-math .katex')),
  }))
  record('inline maths opens for editing', {
    ...mathInlineOpen,
    ...mathInlineEdit,
    ...mathInlineDone,
  })

  await startTyping('# probe\n\ntext\n')
  await page.keyboard.press('Enter')
  await page.keyboard.type('```bash')
  await page.keyboard.press('Enter')
  await page.keyboard.type('echo hi')
  record(
    '```lang + Enter opens a fence',
    await settled(page, () => {
      const input = document.querySelector('#write pre.md-fences .code-tooltip .ty-cm-lang-input')
      const fence = input?.closest('pre')
      if (!fence) return { fence: false, field: false, corner: false }
      const a = input.getBoundingClientRect()
      const b = fence.getBoundingClientRect()
      return {
        fence: fence.matches('[lang="bash"]'),
        field: input.value === 'bash',
        // Bottom right, where Typora puts it and where themes expect to find it.
        corner: b.right - a.right < 24 && b.bottom - a.bottom < 24,
      }
    }),
    '.code-tooltip: 67 theme rules, .ty-cm-lang-input: 6'
  )

  await page.fill('#write pre.md-fences .ty-cm-lang-input', 'python')
  await page.press('#write pre.md-fences .ty-cm-lang-input', 'Enter')
  record(
    'the language field retags a fence',
    await settled(page, () => ({
      tagged: Boolean(document.querySelector('#write pre.md-fences[lang="python"]')),
      markdown: window.__kiwidown.getMarkdown().includes('```python'),
      kept: window.__kiwidown.getMarkdown().includes('echo hi'),
    }))
  )

  // …including into and back out of a diagram, which is a different node view entirely.
  await page.fill('#write pre.md-fences .ty-cm-lang-input', 'mermaid')
  await page.press('#write pre.md-fences .ty-cm-lang-input', 'Enter')
  record(
    'retagging reaches diagrams too',
    await settled(
      page,
      () => ({
        panel: Boolean(document.querySelector('#write pre.md-diagram .md-diagram-panel')),
        // Without a field on the diagram as well, mermaid would be a one-way door.
        reversible: Boolean(document.querySelector('#write pre.md-diagram .ty-cm-lang-input')),
      }),
      15_000
    )
  )

  // Long lines scroll inside the fence rather than stretching the page. The scroller moved
  // from the <pre> to the <code> so the language field would have a corner to sit in that
  // doesn't scroll away — and so themes can hang it outside the block, as notion does.
  await page.evaluate(() => {
    window.__kiwidown.setMarkdown(`# probe\n\n\`\`\`js\nconst x = "${'wide '.repeat(120)}"\n\`\`\`\n`)
  })
  record(
    'long code scrolls inside its fence',
    await settled(page, () => {
      const code = document.querySelector('#write pre.md-fences > code')
      const fence = code?.closest('pre')
      const write = document.getElementById('write')
      if (!code) return { scrolls: false, contained: false, page: false }
      return {
        scrolls: code.scrollWidth > code.clientWidth + 8,
        contained: Math.round(fence.getBoundingClientRect().width) <= Math.round(write.clientWidth),
        page: document.documentElement.scrollWidth <= window.innerWidth,
      }
    })
  )

  // --- the document tab ------------------------------------------------------------
  page.on('dialog', (dialog) => dialog.accept())
  await page.fill('.app-doc-name', 'my notes')
  await page.press('.app-doc-name', 'Enter')
  const renamed = await settled(page, () => ({
    // The extension is added: the name's job is to be the default in the save dialog.
    named: window.__kiwidown.store.state.name === 'my notes.md',
    shown: document.querySelector('.app-doc-name')?.value === 'my notes.md',
    titled: document.title.includes('my notes.md'),
  }))
  await page.click('.app-doc-close')
  const closed = await settled(page, () => ({
    reset: document.querySelector('.app-doc-name')?.value === 'untitled.md',
    empty: window.__kiwidown.getMarkdown().trim() === '',
  }))
  record('the document tab renames and closes', { ...renamed, ...closed })

  // --- more than one document -------------------------------------------------------
  //
  // Tabs are only worth having if leaving one costs nothing, so what's under test is the
  // round trip: the text, the place you had scrolled to and what undo would do all have to
  // come back. The editor is a single ProseMirror instance shared by every tab, which is
  // exactly why none of that is free.
  const opened = await page.evaluate(() => {
    const store = window.__kiwidown.store
    store.newDocument('# first\n\nshort\n')
    const first = store.activeId
    const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}.`).join('\n\n')
    store.newDocument(`# second\n\n${long}\n`)
    return { first, second: store.activeId, count: store.documents.length }
  })
  record('opening documents adds tabs', {
    counted: opened.count === 3,
    ...(await settled(page, () => ({
      tabs: document.querySelectorAll('.app-doc-tab').length === 3,
      // Only the active tab carries the name field; the rest are buttons that switch.
      field: document.querySelectorAll('.app-doc-name').length === 1,
      named:
        document.querySelector('.app-doc-tab.is-active .app-doc-name')?.value ===
        window.__kiwidown.store.state.name,
    }))),
  })

  // Type before scrolling, not after: an edit scrolls the caret into view, so doing it the
  // other way round would be measuring the caret rather than the scroll position.
  await page.evaluate(() =>
    window.__kiwidown.withView((view) => {
      const { state } = view
      const TextSelection = state.selection.constructor
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)))
      view.focus()
    })
  )
  await page.keyboard.type(' EDITED')
  await page.waitForTimeout(300)
  const scrolled = await page.evaluate(() => {
    const content = document.querySelector('content')
    content.scrollTop = 1200
    return content.scrollTop
  })

  await page.evaluate((id) => window.__kiwidown.store.activate(id), opened.first)
  const away = await settled(page, () => ({
    switched: window.__kiwidown.getMarkdown().includes('# first'),
    top: document.querySelector('content').scrollTop === 0,
  }))
  await page.evaluate((id) => window.__kiwidown.store.activate(id), opened.second)
  const back = await settled(page, () => ({
    content: window.__kiwidown.getMarkdown().includes('EDITED'),
    scroll: Math.abs(document.querySelector('content').scrollTop - 1200) < 4,
  }))
  record('switching keeps each document where it was', { ...away, ...back, scrolled: scrolled === 1200 })

  // Undo is plugin state, and plugin state travels with the EditorState — which is the
  // whole reason a switch swaps states rather than reparsing the Markdown.
  await page.keyboard.press('Control+z')
  record(
    'undo history survives a switch',
    await settled(page, () => ({
      undone: !window.__kiwidown.getMarkdown().includes('EDITED'),
      kept: window.__kiwidown.getMarkdown().includes('Paragraph 0.'),
    }))
  )

  // The recovery buffer holds every document with unsaved changes, not just the one on
  // screen — a crash with three tabs open shouldn't cost two of them. Typed rather than
  // set, so this covers the path a real edit takes: switching focuses the editor, which is
  // what makes the next keystroke land in the document that was switched to.
  await page.evaluate((id) => window.__kiwidown.store.activate(id), opened.first)
  await page.keyboard.type('XX')
  await page.evaluate((id) => window.__kiwidown.store.activate(id), opened.second)
  await page.keyboard.type('YY')
  record(
    'the recovery buffer holds every unsaved document',
    await settled(page, () => {
      const draft = JSON.parse(localStorage.getItem('kiwidown.draft') ?? 'null')
      return {
        dirty: window.__kiwidown.store.documents.filter((doc) => doc.dirty).length === 2,
        docs: draft?.docs?.length === 2,
        text: Boolean(draft?.docs?.every((doc) => doc.text.includes('XX') || doc.text.includes('YY'))),
      }
    })
  )

  // Opening several files at once has to open all of them — one tab each, and the first
  // of them shown. (The picker is native, so this goes in through the drop path, which
  // adopts files the same way.)
  const dropped = await page.evaluate(async () => {
    const store = window.__kiwidown.store
    await store.loadFiles([new File(['# one\n'], 'one.md'), new File(['# two\n'], 'two.md')])
    return { names: store.documents.map((doc) => doc.name), active: store.state.name }
  })
  record('opening several files opens several tabs', {
    one: dropped.names.includes('one.md'),
    two: dropped.names.includes('two.md'),
    active: dropped.active === 'one.md',
  })

  // Clicking a tab is the path everything above went round, so it gets its own check.
  await page.locator('.app-doc-tab:not(.is-active) .app-doc-switch').first().click()
  record(
    'clicking a tab switches to it',
    await settled(page, () => {
      const active = document.querySelector('.app-doc-tab.is-active')
      return {
        one: document.querySelectorAll('.app-doc-tab.is-active').length === 1,
        matches: active?.dataset.doc === window.__kiwidown.store.activeId,
        shown: document.querySelector('.app-doc-name')?.value === window.__kiwidown.store.state.name,
      }
    })
  )

  // Typing a name and then clicking another tab, which is two things at once: the name has
  // to land on the document it was typed into rather than the one being switched to, and
  // the switch has to happen at all — committing the name resizes the tab and shifts every
  // tab after it, so a switch that waited for the click would be aimed at stale geometry.
  await page.fill('.app-doc-name', 'renamed-mid-switch')
  await page.locator('.app-doc-tab:not(.is-active) .app-doc-switch').first().click()
  record(
    'a rename commits before the switch it triggers',
    await settled(page, () => ({
      renamed: window.__kiwidown.store.documents.some((doc) => doc.name === 'renamed-mid-switch.md'),
      switched: window.__kiwidown.store.state.name !== 'renamed-mid-switch.md',
      shown: document.querySelector('.app-doc-name')?.value === window.__kiwidown.store.state.name,
    }))
  )

  // A clean console is itself a check: an exception thrown inside a node view leaves the
  // DOM assertions passing while the editor is quietly broken.
  if (!tally(consoleErrors.length === 0)) {
    console.log(`\n  FAIL  ${consoleErrors.length} console error(s):`)
    for (const e of [...new Set(consoleErrors)]) console.log(`        ${e}`)
  }

  return { failed, total: checks }
}

async function main() {
  const preview = startPreview()
  let browser
  let outcome
  try {
    await preview.ready
    browser = await chromium.launch({ channel: 'chrome' })
    outcome = await run(browser)
  } finally {
    await browser?.close()
    preview.proc.kill()
  }

  if (outcome.failed > 0) {
    console.error(`\n${outcome.failed} of ${outcome.total} contract checks failed.`)
    process.exit(1)
  }
  console.log(`\nAll ${outcome.total} contract checks passed.`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
