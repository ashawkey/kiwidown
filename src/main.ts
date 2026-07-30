import './app/shell.css'
import { bindDocumentShortcuts, bindFileDrop, bindUnloadGuard, createDocumentBar } from './app/document-bar'
import { createDisplayControls } from './app/display-controls'
import { createSourceMode, type SourceMode } from './app/source-mode'
import { createThemePicker } from './app/theme-picker'
import { askToast, reportError } from './app/toast'
import { DocumentStore } from './doc'
import { createDocumentViews, type DocumentViews } from './doc/views'
import { createEditor } from './editor'
import { bindClickToFocus } from './editor/click-to-focus'
import { initialThemeId, installBaseLayer, loadThemeIndex } from './theme'
import { welcomeMarkdown } from './welcome'
import type { EditorView } from '@milkdown/kit/prose/view'

/*
 * A Markdown editor that wears real Typora themes.
 *
 * The stage holds a Milkdown editor emitting Typora's DOM (see doc/dom-contract.md), the
 * theme engine dresses it, and the document store connects it to files on disk.
 */

function fail(message: string, error: unknown): void {
  console.error(message, error)
  const pre = document.createElement('pre')
  pre.className = 'app-error'
  pre.textContent = `${message}\n\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
  document.getElementById('app')?.prepend(pre)
}

async function main(): Promise<void> {
  const app = document.getElementById('app')
  if (!app) throw new Error('#app missing from index.html')

  const bar = document.createElement('header')
  bar.className = 'app-bar'
  // The mark stands in for the name, so it has to carry the name for anyone who can't see
  // it — and a title, since a lone emoji is otherwise unexplained.
  const title = document.createElement('span')
  title.className = 'app-bar__title'
  title.textContent = '🥝'
  title.setAttribute('role', 'img')
  title.setAttribute('aria-label', 'Kiwidown')
  title.title = 'Kiwidown'

  const stage = document.createElement('div')
  stage.className = 'app-stage'
  // <content> is the element Typora scrolls; see src/theme/compat.css.
  const content = document.createElement('content')
  stage.appendChild(content)

  installBaseLayer()
  await loadThemeIndex()
  let displayControls: ReturnType<typeof createDisplayControls> | undefined
  const picker = createThemePicker((theme) => void displayControls?.refreshForTheme(theme.href))
  app.append(bar, stage)
  await picker.select(initialThemeId())

  const initial = welcomeMarkdown()

  // The store needs to read and write the editor, and the editor needs to tell the store
  // when it changed — so the store is created first with a placeholder, then bound.
  let getMarkdown: () => string = () => initial
  let views: DocumentViews | undefined
  let viewMode: SourceMode | undefined
  const modeControl = {
    isSource: () => viewMode?.isSource ?? false,
    insertTable: (rows: number, columns: number) => viewMode?.insertTable(rows, columns),
    toggle: () => viewMode?.toggle(),
  }

  const store = new DocumentStore(
    {
      read: () => getMarkdown(),
      write: (markdown) => (viewMode ? viewMode.replace(markdown) : views?.replace(markdown)),
      swap: (next, previous) =>
        viewMode ? viewMode.swap(next, previous) : views?.swap(next, previous),
      forget: (id) => (viewMode ? viewMode.forget(id) : views?.forget(id)),
      onChange: () => documentBar.render(),
      onError: reportError,
    },
    initial
  )

  const documentBar = createDocumentBar(store, modeControl)
  bar.append(title, documentBar.element, picker.element)

  const editor = await createEditor({
    root: content,
    defaultValue: initial,
    // Hidden ProseMirror updates keep tab state aligned while source mode is active; the
    // textarea itself is the authoritative change source in that mode.
    onChange: () => {
      if (!viewMode?.isSource) store.noteEdit()
    },
  })
  displayControls = createDisplayControls()
  bar.insertBefore(displayControls.element, picker.element)

  // Everything above only ever runs before the first user action, so nothing has asked to
  // switch or replace a document yet; from here on both go through the active editor mode.
  views = createDocumentViews(editor, content)
  viewMode = createSourceMode({
    stage,
    content,
    editor,
    views,
    activeId: () => store.activeId,
    onEdit: () => store.noteEdit(),
    onModeChange: () => documentBar.render(),
  })
  getMarkdown = viewMode.getMarkdown
  store.ready()

  bindDocumentShortcuts(store, modeControl)
  bindUnloadGuard(store)
  bindFileDrop(store, stage)

  // Clicking the margins or the space below the document starts writing there, rather
  // than doing nothing — which on an empty document is the difference between an obvious
  // editor and a blank page.
  let view: EditorView | undefined
  editor.withView((v) => (view = v))
  bindClickToFocus(content, () => view)

  document.documentElement.dataset['appReady'] = 'true'

  // Startup loads, in priority order. ?src= is an explicit request and wins; otherwise
  // offer to restore whatever the last session left behind.
  const src = new URLSearchParams(location.search).get('src')
  if (src) {
    await store.loadFromUrl(src)
  } else {
    const draft = store.recoverDraft()
    if (draft) {
      const when = new Date(draft.at).toLocaleString()
      const what = draft.docs.length === 1 ? 'Unsaved changes' : `${draft.docs.length} unsaved documents`
      const restore = await askToast(`${what} from ${when}.`, 'Restore', 'Discard')
      if (restore) store.restoreDrafts(draft.docs)
      else store.discardDraft()
    }
  }

  // Test hook for scripts/check-contract.mjs. Serialising the document and applying a
  // transaction are both things the checks need and neither is observable from the DOM:
  // round-tripping Markdown requires the serialiser, and verifying that decorations
  // rebuild correctly requires provoking a document change without depending on synthetic
  // clicks landing on the right eight-pixel token span.
  Object.defineProperty(window, '__kiwidown', {
    value: {
      getMarkdown: viewMode.getMarkdown,
      setMarkdown: viewMode.replace,
      withView: editor.withView,
      source: initial,
      store,
    },
    configurable: true,
  })
}

main().catch((error) => fail('Failed to start.', error))
