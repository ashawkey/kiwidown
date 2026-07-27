import { Download, FilePlus, FolderOpen, Save, X } from 'lucide'

import type { DocumentState, DocumentStore } from '../doc'
import { supportsFileSystemAccess } from '../doc'
import { icon, iconButton } from './icon'
import { toast } from './toast'

/**
 * The open documents, and the open/save controls.
 *
 * One tab per document. Clicking a tab switches to it; the active one carries an editable
 * name field, because that name is what the save dialog will suggest — naming the thing
 * first and saving it later is how people work, and "untitled" is only the default, not a
 * statement of fact. Inactive tabs are plain buttons, so a click switches rather than
 * dropping a caret into a filename nobody meant to edit.
 *
 * "Save" is labelled honestly: without the File System Access API there is no way to write
 * back to the file the user opened, so the button says "Download" and the document stays
 * unbound rather than pretending a save happened.
 */
export function createDocumentBar(store: DocumentStore): {
  element: HTMLElement
  render: () => void
} {
  const wrap = document.createElement('div')
  wrap.style.display = 'contents'

  const strip = document.createElement('div')
  strip.className = 'app-doc-tabs'
  strip.setAttribute('aria-label', 'Open documents')

  const name = document.createElement('input')
  name.className = 'app-doc-name'
  name.type = 'text'
  name.spellcheck = false
  name.autocomplete = 'off'
  name.setAttribute('aria-label', 'Document name')

  /*
   * An <input> is sized in characters, not in the text it holds, so it is measured against
   * a copy of itself: same font, same content, laid out and then read back. The alternative
   * (`size`, or `field-sizing: content`) is either approximate or Chromium-only.
   */
  const mirror = document.createElement('span')
  mirror.className = 'app-doc-mirror'
  mirror.setAttribute('aria-hidden', 'true')

  function fit(): void {
    mirror.textContent = name.value || name.placeholder
    const measured = mirror.offsetWidth
    // The first render happens before main.ts puts the bar in the page, and an element
    // outside the document measures zero — which would leave the field at its minimum width
    // showing "untitl…" until something else happened to re-render it. Measure again once
    // it is in. `isConnected` rather than the width alone, so a bar that is merely hidden
    // settles instead of asking for frames forever.
    if (!mirror.isConnected) {
      requestAnimationFrame(fit)
      return
    }
    name.style.width = `${Math.min(240, Math.max(48, measured + 2))}px`
  }

  const commit = () => {
    const before = store.state.name
    const boundBefore = Boolean(store.state.handle)
    const after = store.rename(name.value)
    name.value = after
    fit()
    if (after !== before && boundBefore) {
      toast(`Renamed to ${after}. Saving will ask where to put it.`)
    }
  }

  // `change` covers both leaving the field and pressing Enter, and fires only when the
  // value actually differs from what it was when editing started.
  name.addEventListener('change', commit)
  name.addEventListener('input', fit)
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      name.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      name.value = store.state.name
      fit()
      name.blur()
    }
    // Otherwise let it through: Ctrl+S while naming a file should still save it.
  })

  interface Tab {
    root: HTMLElement
    /** The name, and the click target that switches to this document. */
    label: HTMLButtonElement
    close: HTMLButtonElement
  }

  const tabs = new Map<string, Tab>()

  function tabFor(doc: DocumentState): Tab {
    const existing = tabs.get(doc.id)
    if (existing) return existing

    const root = document.createElement('div')
    root.className = 'app-doc-tab'
    root.dataset['doc'] = doc.id

    const label = document.createElement('button')
    label.type = 'button'
    label.className = 'app-doc-switch'
    label.addEventListener('click', () => store.activate(doc.id))

    // The unsaved marker and the close button share one slot: a tab is either telling you
    // it has unsaved changes or offering to close, never both, and reserving room for both
    // leaves every tab trailing a stretch of empty capsule.
    const mark = document.createElement('span')
    mark.className = 'app-doc-mark'

    const dirty = document.createElement('span')
    dirty.className = 'app-doc-dot'
    dirty.setAttribute('aria-hidden', 'true')
    dirty.textContent = '•'

    const close = iconButton(X, 'Close document', () => closeDocument(store, doc.id))
    close.classList.add('app-doc-close')
    mark.append(dirty, close)

    // Middle-click closes a tab, as it does in every other tabbed thing.
    root.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return
      event.preventDefault()
      closeDocument(store, doc.id)
    })

    /*
     * Switching happens on press, not on click, and takes the whole tab rather than just
     * its label.
     *
     * On press because of what a click has to survive: leaving the name field commits a
     * rename, which resizes the active tab and shifts every tab after it — so a strip that
     * reflows between press and release leaves the release landing somewhere else, and the
     * click that switches documents is simply lost.
     *
     * The order below is the point. `preventDefault` stops the browser moving focus on its
     * own, then the field is blurred explicitly, which commits the rename to the document
     * it was typed into — before the switch, rather than after it, when that name would
     * land on the document being switched to.
     */
    root.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      if (doc.id === store.activeId) return
      // The close button is its own action, and doesn't want the document opened first.
      if (event.target instanceof Node && close.contains(event.target)) return
      event.preventDefault()
      if (document.activeElement === name) name.blur()
      store.activate(doc.id)
    })

    root.append(label, mark)
    const tab = { root, label, close }
    tabs.set(doc.id, tab)
    return tab
  }

  const group = document.createElement('div')
  group.className = 'app-button-group'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Document')

  const newButton = iconButton(FilePlus, 'New document', () => store.newDocument(), {
    shortcut: 'Ctrl+Alt+N',
  })
  const openButton = iconButton(FolderOpen, 'Open Markdown files', () => void store.open(), {
    shortcut: 'Ctrl+O',
  })
  const saveButton = iconButton(Save, 'Save', () => void store.save(), { shortcut: 'Ctrl+S' })

  group.append(newButton, openButton, saveButton)
  wrap.append(strip, group)

  let shown: string | undefined

  function render(): void {
    const documents = store.documents
    const active = store.state

    // Closed documents first, so the positions below are about the ones that remain.
    for (const [id, tab] of tabs) {
      if (documents.some((doc) => doc.id === id)) continue
      tab.root.remove()
      tabs.delete(id)
    }

    documents.forEach((doc, index) => {
      const tab = tabFor(doc)
      const isActive = doc.id === active.id

      tab.root.classList.toggle('is-active', isActive)
      tab.root.classList.toggle('is-dirty', doc.dirty)
      tab.label.textContent = doc.name
      tab.label.title = doc.name
      if (isActive) tab.label.setAttribute('aria-current', 'true')
      else tab.label.removeAttribute('aria-current')
      const closeLabel = `Close ${doc.name}`
      tab.close.title = closeLabel
      tab.close.setAttribute('aria-label', closeLabel)

      // Put it in the right place — but only if it isn't there already. Re-inserting a
      // node that is already in position still takes it out of the document and puts it
      // back, which blurs anything focused inside it: this runs on every change to the
      // active document, so that would drop the caret out of the name field mid-rename.
      const at = strip.children[index]
      if (at !== tab.root) strip.insertBefore(tab.root, at ?? null)
    })

    // One name field, moved to whichever tab is active — so there is only ever one place
    // to type a filename, and moving it doesn't cost the field its state.
    const activeTab = tabs.get(active.id)
    if (activeTab && name.parentElement !== activeTab.root) {
      activeTab.root.prepend(mirror, name)
    }

    // Never rewrite the field while it is being edited: this runs on every change to the
    // document, and doing so would drop the caret mid-word.
    if (document.activeElement !== name) {
      name.value = active.name
      fit()
    }
    name.title = active.handle
      ? `${active.name} — saves write back to this file`
      : `${active.name} — not linked to a file on disk. Click to rename.`

    // A newly activated tab may be off the end of a full strip. `nearest` keeps this from
    // moving anything that is already visible, including the page itself.
    if (shown !== active.id) {
      activeTab?.root.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      shown = active.id
    }

    // The browser tab is the other place a document's name belongs.
    document.title = `${active.dirty ? '• ' : ''}${active.name} — Kiwidown`

    // Without the File System Access API there is nothing to write back to, so the action
    // is a download — say so in both the icon and the label rather than calling it "Save".
    const writesBack = Boolean(active.handle) || supportsFileSystemAccess()
    const label = writesBack ? 'Save' : 'Download a copy'
    const description = `${label}  (Ctrl+S)`
    saveButton.title = description
    saveButton.setAttribute('aria-label', description)
    saveButton.replaceChildren(icon(writesBack ? Save : Download))
    saveButton.classList.toggle('is-emphasis', active.dirty)
  }

  render()
  return { element: wrap, render }
}

/** Close a document, asking first if it holds unsaved changes. */
function closeDocument(store: DocumentStore, id = store.activeId): void {
  const doc = store.documents.find((entry) => entry.id === id)
  if (!doc) return
  if (doc.dirty && !confirm(`Discard unsaved changes to ${doc.name}?`)) return
  store.close(id)
}

/** Switch `delta` tabs along, wrapping at either end. */
function stepDocument(store: DocumentStore, delta: number): void {
  const documents = store.documents
  if (documents.length < 2) return
  const index = documents.findIndex((doc) => doc.id === store.activeId)
  const next = documents[(index + delta + documents.length) % documents.length]
  if (next) store.activate(next.id)
}

/**
 * Ctrl/Cmd shortcuts for the document commands.
 *
 * Bound on the window rather than the editor so they work with focus anywhere in the app,
 * and `preventDefault` matters for all of them — Ctrl+S would otherwise offer to save the
 * page itself, and Ctrl+O would open a file into the browser and navigate away from the
 * unsaved document.
 *
 * The tab commands take Alt as well, for the same reason Ctrl+N does: the browser keeps
 * Ctrl+Tab, Ctrl+W and Ctrl+1…9 for its own tabs and never delivers them to the page.
 */
export function bindDocumentShortcuts(store: DocumentStore): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase()

    if (key === 's') {
      event.preventDefault()
      void (event.shiftKey ? store.saveAs() : store.save())
    } else if (key === 'o') {
      event.preventDefault()
      void store.open()
    } else if (!event.altKey) {
      return
    } else if (key === 'n') {
      event.preventDefault()
      store.newDocument()
    } else if (key === 'w') {
      event.preventDefault()
      closeDocument(store)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      stepDocument(store, 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      stepDocument(store, -1)
    }
  }

  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}

/** Warn before closing the browser tab with unsaved changes in any document. */
export function bindUnloadGuard(store: DocumentStore): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!store.documents.some((doc) => doc.dirty)) return
    event.preventDefault()
    // Browsers show their own wording; assigning returnValue is what triggers the prompt.
    event.returnValue = ''
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  return () => window.removeEventListener('beforeunload', onBeforeUnload)
}

/** Accept Markdown files dropped anywhere on the page, one tab each. */
export function bindFileDrop(store: DocumentStore, zone: HTMLElement): () => void {
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    zone.classList.add('is-drop-target')
  }
  const onDragLeave = (event: DragEvent) => {
    if (event.relatedTarget && zone.contains(event.relatedTarget as Node)) return
    zone.classList.remove('is-drop-target')
  }
  const onDrop = (event: DragEvent) => {
    const files = [...(event.dataTransfer?.files ?? [])]
    if (!files.length) return
    event.preventDefault()
    zone.classList.remove('is-drop-target')
    // Nothing is at risk: dropped files open in their own tabs.
    void store.loadFiles(files)
  }

  zone.addEventListener('dragover', onDragOver)
  zone.addEventListener('dragleave', onDragLeave)
  zone.addEventListener('drop', onDrop)
  return () => {
    zone.removeEventListener('dragover', onDragOver)
    zone.removeEventListener('dragleave', onDragLeave)
    zone.removeEventListener('drop', onDrop)
  }
}
