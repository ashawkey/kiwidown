import { knownLanguages } from '../code-highlight/languages'

/*
 * The language field in a fence's bottom-right corner.
 *
 * Typora puts one there and themes already know it: a `.code-tooltip` holding
 * `input.ty-input.ty-input-after.ty-cm-lang-input`. Emitting that exact markup means a
 * theme's own treatment of the label — notion hangs it under the block as a tab, claude
 * moves it to the top-left — applies without any of them being written for us.
 *
 * Suggestions come from a shared <datalist>: one element for the whole page rather than one
 * per fence, since a document can easily hold dozens.
 */

const DATALIST_ID = 'kiwidown-fence-languages'

/** Mermaid is rendered by ../diagram rather than highlighted, so refractor doesn't list it. */
const EXTRA_LANGUAGES = ['mermaid']

function suggestions(): string {
  if (!document.getElementById(DATALIST_ID)) {
    const list = document.createElement('datalist')
    list.id = DATALIST_ID
    for (const name of [...new Set([...knownLanguages(), ...EXTRA_LANGUAGES])].sort()) {
      const option = document.createElement('option')
      option.value = name
      list.appendChild(option)
    }
    document.body.appendChild(list)
  }
  return DATALIST_ID
}

export interface LanguageChip {
  element: HTMLElement
  /** Reflect a language that changed elsewhere — undo, a reloaded file. */
  set: (language: string) => void
  contains: (node: Node | null | undefined) => boolean
}

export interface LanguageChipOptions {
  language: string
  /** A new language, committed on Enter or on leaving the field — never per keystroke. */
  onCommit: (language: string) => void
  /** Editing is over; put the caret back in the code. */
  onDone: () => void
}

export function createLanguageChip(options: LanguageChipOptions): LanguageChip {
  let committed = options.language

  const element = document.createElement('div')
  element.className = 'code-tooltip'
  // Nothing in here is document content; the <input> keeps working because a form control
  // is focusable regardless of the surrounding contenteditable.
  element.contentEditable = 'false'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'ty-input ty-input-after ty-cm-lang-input'
  input.value = committed
  input.placeholder = 'language'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.setAttribute('list', suggestions())
  input.setAttribute('aria-label', 'Code language')
  input.title = 'Language for this code block'

  /*
   * Committing per keystroke would re-tokenise the block on every letter and, worse, tear
   * the field out from under the user the moment the text passed through `mermaid` — that
   * swaps the whole node view for a diagram. So the document only hears about a language
   * once the user is done saying it.
   */
  const commit = () => {
    const value = input.value.trim().toLowerCase()
    input.value = value
    if (value === committed) return
    committed = value
    options.onCommit(value)
  }

  input.addEventListener('change', commit)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
      options.onDone()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      input.value = committed
      options.onDone()
    }
  })

  element.appendChild(input)

  return {
    element,
    set: (language) => {
      committed = language
      if (document.activeElement !== input) input.value = language
    },
    contains: (node) => Boolean(node && element.contains(node)),
  }
}
