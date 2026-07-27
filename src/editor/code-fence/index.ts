import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { Node } from '@milkdown/kit/prose/model'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'

import { DIAGRAM_LANGUAGE, DiagramView } from '../diagram'
import { FENCE_CLASS } from '../typora-dom'
import { createLanguageChip, type LanguageChip } from './language-chip'

/*
 * The one node view every `code_block` gets.
 *
 * It has to be one, not two. ProseMirror collects `nodeViews` from every plugin into a
 * single map keyed by node name and the first registration wins outright, so a second
 * plugin claiming `code_block` would simply never be consulted — the diagram view and the
 * ordinary fence have to be dispatched from the same place.
 *
 * What the plain fence adds over the schema's own toDOM is Typora's language field: an
 * `input.ty-cm-lang-input` inside a `.code-tooltip`, pinned to the bottom-right corner. It
 * is the only way to retag a fence once it exists — the ``` line that named the language is
 * consumed when the block is created, so in a WYSIWYG editor there is nothing left to edit.
 */

const CODE_BLOCK = 'code_block'

class FenceView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  #chip: LanguageChip
  #language: string

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.#language = String(node.attrs['language'] ?? '')

    this.dom = document.createElement('pre')
    this.dom.className = FENCE_CLASS
    this.contentDOM = document.createElement('code')

    this.#chip = createLanguageChip({
      language: this.#language,
      onCommit: (language) => {
        const pos = getPos()
        if (pos == null) return
        view.dispatch(view.state.tr.setNodeAttribute(pos, 'language', language))
      },
      onDone: () => view.focus(),
    })

    this.dom.append(this.contentDOM, this.#chip.element)
    this.#applyLanguage()
  }

  /**
   * Typora tags the fence with `lang`, and themes read it — claude draws its own label
   * from `attr(lang)`. Only when there is one: `[lang]` matches an empty attribute too,
   * which would leave those themes drawing an empty badge on every untagged fence.
   */
  #applyLanguage(): void {
    if (this.#language) {
      this.dom.setAttribute('lang', this.#language)
      this.dom.dataset['language'] = this.#language
    } else {
      this.dom.removeAttribute('lang')
      delete this.dom.dataset['language']
    }
  }

  update(node: Node): boolean {
    // A fence that has become a diagram needs the other view entirely, and a node view
    // cannot change its mind — returning false makes ProseMirror rebuild it.
    if (node.type.name !== CODE_BLOCK || node.attrs['language'] === DIAGRAM_LANGUAGE) return false
    const language = String(node.attrs['language'] ?? '')
    if (language !== this.#language) {
      this.#language = language
      this.#applyLanguage()
      this.#chip.set(language)
    }
    return true
  }

  ignoreMutation(mutation: { target: globalThis.Node }): boolean {
    return this.#chip.contains(mutation.target)
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof globalThis.Node && this.#chip.contains(event.target)
  }
}

/** Fences, with a language field — and diagrams, which are fences that draw themselves. */
export const codeFence: MilkdownPlugin[] = [
  $prose(
    () =>
      new Plugin({
        key: new PluginKey('TYPORA_CODE_FENCE'),
        props: {
          nodeViews: {
            [CODE_BLOCK]: (node: Node, view: EditorView, getPos: () => number | undefined) =>
              (node.attrs['language'] === DIAGRAM_LANGUAGE
                ? new DiagramView(node, view, getPos)
                : new FenceView(node, view, getPos)) as unknown as NodeView,
          },
        },
      })
  ),
].flat()
