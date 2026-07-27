/*
 * Reading and writing real .md files from the browser.
 *
 * The File System Access API gives a genuine open/save cycle — pick a file once, then
 * Ctrl+S writes back to it. It's Chromium-only, so everywhere else falls back to
 * <input type="file"> for opening and a download for saving. The fallback can't write back
 * to the original file; callers surface that by keeping the document marked as having no
 * handle, so "Save" stays "Download".
 *
 * Typed locally rather than depending on ambient DOM lib versions, which disagree about
 * whether these exist.
 */

export interface FileHandle {
  readonly name: string
  getFile: () => Promise<File>
  createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>
  queryPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
}

interface PickerOptions {
  suggestedName?: string
  types?: Array<{ description: string; accept: Record<string, string[]> }>
}

interface FilePickerWindow {
  showOpenFilePicker?: (options: PickerOptions & { multiple?: boolean }) => Promise<FileHandle[]>
  showSaveFilePicker?: (options: PickerOptions) => Promise<FileHandle>
}

const MARKDOWN_TYPES = [
  {
    description: 'Markdown',
    accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd'] },
  },
]

export const MARKDOWN_EXTENSIONS = /\.(md|markdown|mdown|mkd|txt)$/i

export function supportsFileSystemAccess(): boolean {
  const w = window as unknown as FilePickerWindow
  return typeof w.showOpenFilePicker === 'function' && typeof w.showSaveFilePicker === 'function'
}

/** Sentinel for "the user dismissed the picker" — a normal outcome, not a failure. */
export const CANCELLED = Symbol('cancelled')

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export interface OpenedFile {
  name: string
  text: string
  /** Absent when opened through the fallback, which can't write back. */
  handle?: FileHandle
}

/**
 * Prompt for Markdown files. Returns {@link CANCELLED} if the user backs out.
 *
 * Several at once, because each one becomes its own tab: picking a folder's worth of notes
 * in one dialog is the whole reason to have tabs.
 */
export async function openFiles(): Promise<OpenedFile[] | typeof CANCELLED> {
  const w = window as unknown as FilePickerWindow
  if (w.showOpenFilePicker) {
    try {
      const handles = await w.showOpenFilePicker({ types: MARKDOWN_TYPES, multiple: true })
      if (!handles.length) return CANCELLED
      return await Promise.all(
        handles.map(async (handle) => ({
          name: handle.name,
          text: await (await handle.getFile()).text(),
          handle,
        }))
      )
    } catch (error) {
      if (isAbort(error)) return CANCELLED
      throw error
    }
  }

  return openViaInput()
}

/**
 * Fallback open. `<input type="file">` fires no event when the dialog is dismissed, so
 * cancellation is detected by watching for focus returning to the window with nothing
 * selected — imperfect, but the alternative is a promise that never settles.
 */
function openViaInput(): Promise<OpenedFile[] | typeof CANCELLED> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.md,.markdown,.mdown,.mkd,.txt,text/markdown,text/plain'
    input.style.display = 'none'

    let settled = false
    const finish = (value: OpenedFile[] | typeof CANCELLED) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }

    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])]
      if (!files.length) return finish(CANCELLED)
      Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })))
        .then(finish)
        .catch(reject)
    })

    window.addEventListener(
      'focus',
      () => setTimeout(() => (input.files?.length ? undefined : finish(CANCELLED)), 500),
      { once: true }
    )

    document.body.appendChild(input)
    input.click()
  })
}

/** Write `text` back to an already-opened file. */
export async function writeFile(handle: FileHandle, text: string): Promise<void> {
  // A handle from a previous session (or after a reload) may have gone stale; asking again
  // turns a silent failure into a permission prompt.
  if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    const granted = await handle.requestPermission?.({ mode: 'readwrite' })
    if (granted !== 'granted') throw new Error('Permission to write the file was declined.')
  }
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
}

/** Prompt for a destination and write there. Returns the handle for later saves. */
export async function saveFileAs(
  text: string,
  suggestedName: string
): Promise<FileHandle | undefined | typeof CANCELLED> {
  const w = window as unknown as FilePickerWindow
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName, types: MARKDOWN_TYPES })
      await writeFile(handle, text)
      return handle
    } catch (error) {
      if (isAbort(error)) return CANCELLED
      throw error
    }
  }

  downloadText(text, suggestedName)
  // No handle: a download is one-way, so the document stays unbound and the next save
  // downloads again rather than pretending it wrote somewhere.
  return undefined
}

/** Fallback save, and the mechanism behind exports. */
export function downloadText(text: string, filename: string, type = 'text/markdown'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
