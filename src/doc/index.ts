import {
  CANCELLED,
  type FileHandle,
  MARKDOWN_EXTENSIONS,
  openFiles,
  saveFileAs,
  supportsFileSystemAccess,
  writeFile,
} from './file-access'

/**
 * A filename the browser will accept as a save target.
 *
 * The extension is added rather than assumed: the name's whole job is to be the default in
 * the save dialog, and `notes` there produces a file no Markdown editor will open by
 * double-click. Names that already end in a Markdown extension are left alone.
 */
export function normaliseName(raw: string): string {
  // Windows rejects every one of these outright, and a separator would be read as a
  // path everywhere else: a name typed into a text field can contain any of them.
  // `\` is in the set for the same reason `/` is — it is the separator on the one platform
  // that also refuses the rest of this list.
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return DEFAULT_NAME
  return MARKDOWN_EXTENSIONS.test(cleaned) ? cleaned : `${cleaned}.md`
}

/*
 * The open documents: what they're called, where they came from, and which of them has
 * unsaved changes.
 *
 * One of them is active — the one in the editor — and the rest are held as text. Anything
 * that only the editor knows (undo history, selection, scroll position) is retained by the
 * `swap` hook rather than here, so this file stays about documents and not about
 * ProseMirror.
 *
 * Autosave writes to localStorage on a debounce so a crashed or closed tab doesn't lose
 * work. It is a recovery buffer, not storage — the files on disk are the real documents,
 * and a document drops out of the buffer as soon as the two agree.
 */

const STORAGE_KEY = 'kiwidown.draft'
const AUTOSAVE_DELAY = 800
const DEFAULT_NAME = 'untitled.md'

export interface DocumentState {
  /** Stable for as long as the document is open; how the bar and the editor address it. */
  readonly id: string
  name: string
  /** Present only when we can write back to the original file. */
  handle?: FileHandle
  /** Content as last loaded or saved, for dirty comparison. */
  saved: string
  /** Current content. Live for the active document, last known for the others. */
  text: string
  dirty: boolean
}

interface Draft {
  name: string
  text: string
}

interface Session {
  at: number
  docs: Draft[]
}

export interface DocumentStoreOptions {
  /** Read the editor's current Markdown. */
  read: () => string
  /** Replace the editor's content, discarding anything retained for the active document. */
  write: (markdown: string) => void
  /**
   * Put `next` in the editor, retaining whatever `previous` had open.
   *
   * Optional: without it a switch is just `write(next.text)`, which is correct but forgets
   * undo history and scroll position.
   */
  swap?: (next: DocumentState, previous?: DocumentState) => void
  /** A document was closed; anything retained for it can go. */
  forget?: (id: string) => void
  /** Something about the open documents changed. */
  onChange: () => void
  onError: (message: string, error: unknown) => void
}

let sequence = 0

export class DocumentStore {
  #docs: DocumentState[]
  #activeId: string
  #options: DocumentStoreOptions
  #autosaveTimer: number | undefined
  /**
   * The document the app opened with. It holds the sample document rather than anything
   * the user made, so opening a file may quietly take it over — but only until it has been
   * edited or renamed, after which it is theirs and stays.
   */
  #startupId: string | undefined

  constructor(options: DocumentStoreOptions, initial: string) {
    this.#options = options
    const first = this.#create(initial, DEFAULT_NAME)
    this.#docs = [first]
    this.#activeId = first.id
    this.#startupId = first.id
  }

  /** The document in the editor. There is always exactly one. */
  get state(): DocumentState {
    const active = this.#docs.find((doc) => doc.id === this.#activeId)
    // close() replaces the last document rather than leaving none, so this cannot happen.
    if (!active) throw new Error('no active document')
    return active
  }

  /** Every open document, in tab order. The entries are live; treat them as read-only. */
  get documents(): DocumentState[] {
    return [...this.#docs]
  }

  get activeId(): string {
    return this.#activeId
  }

  get canWriteBack(): boolean {
    return Boolean(this.state.handle)
  }

  #emit(): void {
    this.#options.onChange()
  }

  #create(text: string, name: string, handle?: FileHandle): DocumentState {
    return { id: `doc-${++sequence}`, name, handle, saved: text, text, dirty: false }
  }

  #find(id: string): DocumentState | undefined {
    return this.#docs.find((doc) => doc.id === id)
  }

  /**
   * Adopt the editor's own serialisation of the active document as its baseline.
   *
   * Markdown round-trips through remark, and the text that comes back can differ in
   * formatting from the file on disk — a list bullet respelled, a table's columns padded.
   * Without this, merely opening such a file would show it as having unsaved changes
   * before anything was typed.
   */
  #rebaseline(doc: DocumentState): void {
    doc.text = this.#options.read()
    if (!doc.dirty) doc.saved = doc.text
  }

  /** Called once the editor exists, to baseline the document the app started with. */
  ready(): void {
    this.#rebaseline(this.state)
  }

  /** Call whenever the editor's content changes. */
  noteEdit(): void {
    const active = this.state
    active.text = this.#options.read()
    const dirty = active.text !== active.saved
    if (dirty !== active.dirty) {
      active.dirty = dirty
      this.#emit()
    }
    // Once it has been typed into, the startup document is the user's, not a spare tab.
    if (dirty && this.#startupId === active.id) this.#startupId = undefined

    window.clearTimeout(this.#autosaveTimer)
    this.#autosaveTimer = window.setTimeout(() => this.#autosave(), AUTOSAVE_DELAY)
  }

  #autosave(): void {
    window.clearTimeout(this.#autosaveTimer)
    // The listener that drives noteEdit is debounced, so the newest keystrokes may not
    // have reached the store yet.
    const active = this.state
    active.text = this.#options.read()
    const dirty = active.text !== active.saved
    if (dirty !== active.dirty) {
      active.dirty = dirty
      this.#emit()
    }

    const docs = this.#docs
      .filter((doc) => doc.dirty)
      .map((doc) => ({ name: doc.name, text: doc.text }) satisfies Draft)
    try {
      if (!docs.length) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: Date.now(), docs } satisfies Session))
    } catch {
      // Quota or private-mode failures shouldn't interrupt editing; the files on disk are
      // still the real documents.
    }
  }

  /**
   * Unsaved documents left behind by a previous session.
   *
   * Returned rather than applied, so the caller can ask before restoring — silently
   * reopening them would be its own kind of surprise when the user opened something else.
   */
  recoverDraft(): Session | undefined {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return undefined
      const stored = JSON.parse(raw) as Partial<Session> & Partial<Draft>
      // Sessions before multi-file editing held a single document inline.
      const docs = Array.isArray(stored.docs)
        ? stored.docs
        : typeof stored.text === 'string'
          ? [{ name: stored.name ?? DEFAULT_NAME, text: stored.text }]
          : []
      const usable = docs.filter((doc) => typeof doc?.text === 'string' && doc.text !== this.state.saved)
      if (!usable.length) return undefined
      return { at: stored.at ?? Date.now(), docs: usable }
    } catch {
      return undefined
    }
  }

  discardDraft(): void {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
  }

  /**
   * Reopen recovered drafts as tabs.
   *
   * They come back with unsaved changes, because that is what they are: nothing here has
   * been written to a file, so marking them clean would let the next close discard them
   * without a word.
   */
  restoreDrafts(docs: Draft[]): void {
    let first: string | undefined
    for (const draft of docs) {
      const id = this.#adopt(draft.text, draft.name)
      const doc = this.#find(id)
      if (doc) {
        doc.saved = ''
        doc.dirty = true
      }
      first ??= id
    }
    if (first) this.#activate(first, true)
    else this.#emit()
  }

  /** Make `id` the document in the editor. */
  activate(id: string): void {
    this.#activate(id, false)
  }

  #activate(id: string, force: boolean): void {
    const next = this.#find(id)
    if (!next) return
    if (next.id === this.#activeId && !force) return

    const previous = this.#find(this.#activeId)
    if (previous && previous !== next) {
      // Take the outgoing text straight from the editor: noteEdit is debounced, so the
      // last few keystrokes before a switch may not have arrived.
      previous.text = this.#options.read()
      previous.dirty = previous.text !== previous.saved
    }

    this.#activeId = next.id
    if (this.#options.swap) this.#options.swap(next, previous === next ? undefined : previous)
    else this.#options.write(next.text)
    this.#rebaseline(next)
    this.#autosave()
    this.#emit()
  }

  /** Load content into the active document and treat it as its saved baseline. */
  load(text: string, name = DEFAULT_NAME, handle?: FileHandle): void {
    const active = this.state
    this.#options.write(text)
    active.name = name
    active.handle = handle
    active.dirty = false
    this.#rebaseline(active)
    if (this.#startupId === active.id) this.#startupId = undefined
    this.#autosave()
    this.#emit()
  }

  /**
   * A tab the incoming document may take over, if there is one.
   *
   * Only ever the active tab, and only when nothing would be lost: an empty scratch
   * document, or the sample the app started with. Opening a file with an untouched blank
   * tab in front of you should fill that tab, not leave it behind.
   */
  #reusable(): DocumentState | undefined {
    const active = this.state
    if (active.dirty || active.handle) return undefined
    if (active.id === this.#startupId || active.text.trim() === '') return active
    return undefined
  }

  /** Put a document in a tab — reusing an untouched one if there is one. Returns its id. */
  #adopt(text: string, name: string, handle?: FileHandle): string {
    const reusable = this.#reusable()
    if (reusable) {
      reusable.name = name
      reusable.handle = handle
      reusable.saved = text
      reusable.text = text
      reusable.dirty = false
      this.#startupId = undefined
      // Always the active tab, so the editor has to be told as well.
      this.#options.write(text)
      this.#rebaseline(reusable)
      return reusable.id
    }

    const doc = this.#create(text, name, handle)
    this.#docs.push(doc)
    return doc.id
  }

  /** Open Markdown files, one tab each. */
  async open(): Promise<void> {
    try {
      const files = await openFiles()
      if (files === CANCELLED) return
      let first: string | undefined
      for (const file of files) {
        const id = this.#adopt(file.text, file.name, file.handle)
        first ??= id
      }
      // The first of them, not the last: opening several files should leave you looking at
      // the top of the list, which is the order the picker showed them in.
      if (first) this.#activate(first, true)
    } catch (error) {
      this.#options.onError('Could not open that file.', error)
    }
  }

  /** Save the active document to its file, or prompt for a destination if there isn't one. */
  async save(): Promise<void> {
    const active = this.state
    const text = this.#options.read()
    try {
      if (active.handle) {
        await writeFile(active.handle, text)
        active.saved = text
        active.text = text
        active.dirty = false
        this.#autosave()
        this.#emit()
        return
      }
      await this.saveAs()
    } catch (error) {
      this.#options.onError('Could not save.', error)
    }
  }

  async saveAs(): Promise<void> {
    const active = this.state
    const text = this.#options.read()
    try {
      const handle = await saveFileAs(text, active.name)
      if (handle === CANCELLED) return
      // `undefined` means it went out as a download — the content is safe, but there's
      // nothing to write back to, so the document stays unbound.
      //
      // The picker is also a rename: whatever the user called the file there is what the
      // document is called now, otherwise the tab goes on showing a name nothing on disk
      // has.
      active.handle = handle
      active.name = handle?.name ?? active.name
      active.saved = text
      active.text = text
      active.dirty = false
      this.#autosave()
      this.#emit()
    } catch (error) {
      this.#options.onError('Could not save.', error)
    }
  }

  /** Open an empty document in a new tab. */
  newDocument(template = ''): void {
    const doc = this.#create(template, this.#uniqueName(DEFAULT_NAME))
    this.#docs.push(doc)
    this.#activate(doc.id, true)
  }

  /**
   * A name no open document already has.
   *
   * Only for documents we invent. Two files that genuinely share a name are allowed to
   * show the same name — renaming one of them behind the user's back would be a lie about
   * what is on disk.
   */
  #uniqueName(name: string): string {
    const taken = (candidate: string) => this.#docs.some((doc) => doc.name === candidate)
    if (!taken(name)) return name
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ''
    for (let n = 2; ; n++) {
      const candidate = `${stem}-${n}${extension}`
      if (!taken(candidate)) return candidate
    }
  }

  /**
   * Give the active document a different name.
   *
   * A document bound to a file on disk is *unbound* by this, because the rename cannot
   * reach the file: the File System Access API hands out a handle to one file and no way
   * to move it. Keeping the handle would mean the tab showing one name while Ctrl+S wrote
   * to another — so instead the next save asks where the newly-named file should go.
   *
   * Returns the name actually taken, which may differ from the one asked for.
   */
  rename(raw: string): string {
    const active = this.state
    const name = normaliseName(raw)
    if (name === active.name) return name
    active.name = name
    active.handle = undefined
    if (this.#startupId === active.id) this.#startupId = undefined
    this.#emit()
    // The recovery buffer records each document's name alongside its text; leaving the old
    // one there would restore this document under the name the user just moved away from.
    this.#autosave()
    return name
  }

  /**
   * Close a document — the active one by default.
   *
   * Closing the last one leaves an empty document rather than an empty app: there is
   * nowhere else to put the caret, and "no document open" is a state with no way out that
   * doesn't look broken.
   */
  close(id = this.#activeId): void {
    const index = this.#docs.findIndex((doc) => doc.id === id)
    if (index < 0) return

    const [removed] = this.#docs.splice(index, 1)
    if (removed) this.#options.forget?.(removed.id)

    if (!this.#docs.length) {
      const fresh = this.#create('', DEFAULT_NAME)
      this.#docs.push(fresh)
      this.#activeId = fresh.id
      this.#options.write('')
      this.#rebaseline(fresh)
    } else if (removed?.id === this.#activeId) {
      // The tab that took its place, or the last one if it was at the end — which is
      // where the eye already is.
      const next = this.#docs[Math.min(index, this.#docs.length - 1)]
      if (next) {
        this.#activeId = next.id
        if (this.#options.swap) this.#options.swap(next, undefined)
        else this.#options.write(next.text)
        this.#rebaseline(next)
      }
    }

    this.#autosave()
    this.#emit()
  }

  /** Adopt dropped or pasted files, one tab each. */
  async loadFiles(files: readonly File[]): Promise<void> {
    let first: string | undefined
    for (const file of files) {
      if (!MARKDOWN_EXTENSIONS.test(file.name)) {
        this.#options.onError(`${file.name} doesn't look like a Markdown file.`, undefined)
        continue
      }
      const id = this.#adopt(await file.text(), file.name)
      first ??= id
    }
    if (first) this.#activate(first, true)
  }

  /**
   * Fetch a document named by `?src=` into the active tab.
   *
   * Cross-origin fetches need CORS headers on the far end, which most raw-file hosts send
   * and most web pages don't — a failure here is normal and reported plainly.
   */
  async loadFromUrl(src: string): Promise<boolean> {
    try {
      const url = new URL(src, document.baseURI)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const name = url.pathname.split('/').pop() || DEFAULT_NAME
      this.load(await res.text(), decodeURIComponent(name))
      return true
    } catch (error) {
      this.#options.onError(`Could not load ${src}.`, error)
      return false
    }
  }
}

export { supportsFileSystemAccess }
export type { FileHandle }
