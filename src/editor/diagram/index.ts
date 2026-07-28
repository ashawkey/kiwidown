import type { Node } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'

import { THEME_CHANGE_EVENT } from '../../theme'
import { createLanguageChip, type LanguageChip } from '../code-fence/language-chip'
import { FENCE_CLASS } from '../typora-dom'
import { renderDiagram } from './mermaid-loader'

/*
 * ```mermaid fences, rendered as diagrams.
 *
 * Typora draws these with Mermaid and wraps the result the way themes expect:
 *
 *   <pre class="md-fences md-diagram md-end-block" lang="mermaid">
 *     <code>…source…</code>
 *     <div class="md-diagram-panel">
 *       <div class="md-diagram-panel-preview">…svg…</div>
 *
 * That structure is load-bearing. `.md-diagram` is one of the heaviest selectors in the
 * whole theme set, and the rules under it reach right into Mermaid's own SVG classes —
 * claude restyles `.actor`, `.messageLine0`, `.labelBox`, `.loopLine` and `.cluster` under
 * `.md-diagram-panel-preview`. Rendering with anything other than Mermaid would leave all
 * of that unmatched.
 *
 * Source and preview are siblings, and the source is hidden unless the block has focus
 * (see src/theme/bridge.css) — Typora's behaviour, and why this needs a node view rather
 * than a decoration: a widget could only be placed *inside* the content element, so hiding
 * the source would hide the diagram with it.
 *
 * Registered by ../code-fence, which owns the one node view every `code_block` gets.
 */

const CODE_BLOCK = 'code_block'
export const DIAGRAM_LANGUAGE = 'mermaid'

/** Debounce so a diagram isn't re-parsed on every keystroke while editing its source. */
const RENDER_DELAY = 300

let counter = 0

export class DiagramView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  #panel: HTMLElement
  #preview: HTMLElement
  #chip: LanguageChip
  #source: string
  #timer: number | undefined
  #id = `omr-diagram-${++counter}`
  #refreshForTheme = (): void => {
    this.#schedule()
    // The imported stylesheet can register webfonts after the theme event. A second pass
    // once those fonts settle keeps Mermaid's measured label boxes in sync with the text.
    void document.fonts.ready.then(() => this.#schedule(0))
  }

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.#source = node.textContent

    this.dom = document.createElement('pre')
    // Same classes typora-dom.ts gives an ordinary fence, plus md-diagram.
    this.dom.className = `${FENCE_CLASS} md-diagram`
    this.dom.setAttribute('lang', DIAGRAM_LANGUAGE)
    this.dom.dataset['language'] = DIAGRAM_LANGUAGE

    this.contentDOM = document.createElement('code')

    this.#panel = document.createElement('div')
    this.#panel.className = 'md-diagram-panel'
    this.#panel.contentEditable = 'false'

    this.#preview = document.createElement('div')
    this.#preview.className = 'md-diagram-panel-preview'
    this.#panel.appendChild(this.#preview)

    // The source is hidden until the block has focus, so clicking generated SVG text
    // cannot place a ProseMirror caret in it. Open the source explicitly at its end.
    this.#preview.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const pos = getPos()
      if (pos == null) return
      const size = view.state.doc.nodeAt(pos)?.content.size ?? 0
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1 + size)))
      view.focus()
    })

    // Without this a diagram would be a one-way door: nothing else in the block says
    // `mermaid`, so there would be no way back to an ordinary fence.
    this.#chip = createLanguageChip({
      language: DIAGRAM_LANGUAGE,
      onCommit: (language) => {
        const pos = getPos()
        if (pos == null) return
        view.dispatch(view.state.tr.setNodeAttribute(pos, 'language', language))
      },
      onDone: () => view.focus(),
    })

    this.dom.append(this.contentDOM, this.#panel, this.#chip.element)
    window.addEventListener(THEME_CHANGE_EVENT, this.#refreshForTheme)
    this.#schedule(0)
  }

  #schedule(delay = RENDER_DELAY): void {
    window.clearTimeout(this.#timer)
    this.#timer = window.setTimeout(() => void this.#render(), delay)
  }

  async #render(): Promise<void> {
    const source = this.#source.trim()
    if (!source) {
      this.#preview.replaceChildren()
      return
    }
    const result = await renderDiagram(this.#id, source, this.#preview)
    // Another edit landed while Mermaid was working; that render already superseded this.
    if (source !== this.#source.trim()) return

    if (result.ok) {
      this.#preview.innerHTML = result.svg
      this.#preview.classList.remove('md-diagram-error')
    } else {
      // Mermaid reports syntax errors per-diagram; showing the message beats a blank panel
      // or a stale diagram that no longer matches the source.
      this.#preview.classList.add('md-diagram-error')
      this.#preview.textContent = result.message
    }
  }

  update(node: Node): boolean {
    if (node.type.name !== CODE_BLOCK || node.attrs['language'] !== DIAGRAM_LANGUAGE) return false
    const source = node.textContent
    if (source !== this.#source) {
      this.#source = source
      this.#schedule()
    }
    return true
  }

  /**
   * The preview and the language field are generated; ProseMirror must not read either
   * back as document content.
   *
   * The record is a DOM mutation or a synthetic selection change, so `target` is all
   * that can be relied on.
   */
  ignoreMutation(mutation: { target: globalThis.Node }): boolean {
    return this.#panel.contains(mutation.target) || this.#chip.contains(mutation.target)
  }

  stopEvent(event: Event): boolean {
    return (
      event.target instanceof globalThis.Node &&
      (this.#panel.contains(event.target) || this.#chip.contains(event.target))
    )
  }

  destroy(): void {
    window.clearTimeout(this.#timer)
    window.removeEventListener(THEME_CHANGE_EVENT, this.#refreshForTheme)
  }
}
