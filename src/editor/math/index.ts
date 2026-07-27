import { InputRule, textblockTypeInputRule } from '@milkdown/kit/prose/inputrules'
import { Fragment } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { $inputRule, $nodeSchema, $prose, $remark } from '@milkdown/kit/utils'
import remarkMath from 'remark-math'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { Node, Schema } from '@milkdown/kit/prose/model'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'

import { DELIMITERS } from '../md-meta'
import { loadKatex, renderMath } from './katex-loader'

/*
 * `$inline$` and `$$block$$` maths, rendered with KaTeX.
 *
 * Typora uses MathJax, and some vendored themes have `.MathJax` rules that won't apply
 * here, but those are glyph-level details that MathJax's own stylesheet would normally
 * provide anyway. What matters for theming is the container, and `.md-math-block` and
 * `.md-inline-math` are emitted exactly as Typora does, so block placement, centring and
 * backgrounds all come from the theme.
 *
 * The two nodes are shaped differently because they are edited differently, exactly as in
 * Typora:
 *
 *  - A block is a `md-rawblock`: source above, live preview below, and the source is
 *    revealed only while the caret is inside it (src/theme/bridge.css). So it is an
 *    ordinary code-like textblock and the caret goes in it the way it goes into a fence —
 *    no special editing mode, and multi-line formulas work.
 *  - Inline maths has nowhere to put a second line, so it stays an atom holding its TeX as
 *    an attribute, and selecting it (click, or arrow into it) swaps the rendered output for
 *    a small editable field.
 */

const INLINE = 'math_inline'
const BLOCK = 'math_block'

const remarkMathPlugin = $remark('math', () => remarkMath)

export const mathInlineSchema = $nodeSchema(INLINE, () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { value: { default: '', validate: 'string' } },
  parseDOM: [
    {
      tag: 'span[data-type="math-inline"]',
      getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset['value'] ?? '' }),
    },
  ],
  toDOM: (node) => [
    'span',
    { class: 'md-inline-math', 'data-type': 'math-inline', 'data-value': node.attrs['value'] },
    node.attrs['value'] as string,
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'inlineMath',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value as string })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === INLINE,
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, node.attrs['value'] as string)
    },
  },
}))

export const mathBlockSchema = $nodeSchema(BLOCK, () => ({
  content: 'text*',
  group: 'block',
  marks: '',
  code: true,
  defining: true,
  parseDOM: [
    {
      tag: 'div[data-type="math-block"]',
      preserveWhitespace: 'full',
      // The rendered preview is a sibling of the source inside the same element, so a
      // plain text read would paste the formula back in twice — once as TeX and once as
      // whatever KaTeX laid out.
      getContent: (dom: globalThis.Node, schema: Schema) => {
        const source = (dom as HTMLElement).querySelector('.md-rawblock-input')?.textContent ?? ''
        return source ? Fragment.from(schema.text(source)) : Fragment.empty
      },
    },
  ],
  toDOM: () => [
    'div',
    { class: 'md-math-block md-rawblock md-end-block', 'data-type': 'math-block' },
    ['div', { class: 'md-rawblock-input' }, 0],
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'math',
    runner: (state, node, type) => {
      state.openNode(type)
      const value = node.value as string | undefined
      if (value) state.addText(value)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === BLOCK,
    runner: (state, node) => {
      state.addNode('math', undefined, node.textContent)
    },
  },
}))

/** Views live so they can swap raw TeX for rendered output once KaTeX arrives. */
const pending = new Set<{ render: () => void }>()

/** Render `tex` into `target`, asking for KaTeX if this is the first formula on the page. */
function paint(target: HTMLElement, tex: string, display: boolean, view: { render: () => void }): void {
  const html = renderMath(tex, display)
  if (html === undefined) {
    // Not loaded yet: show the source, and ask for KaTeX.
    target.textContent = tex
    pending.add(view)
    void loadKatex().then(() => {
      for (const waiting of pending) waiting.render()
      pending.clear()
    })
    return
  }
  pending.delete(view)
  // KaTeX output is generated from TeX we control the shape of, and is not user HTML.
  target.innerHTML = html
}

/** One of the `$$` lines that open and close a block. */
function fence(className: string): HTMLElement {
  const element = document.createElement('div')
  element.className = `${className} md-meta md-expand`
  element.contentEditable = 'false'
  element.textContent = '$$'
  return element
}

/**
 * A `$$…$$` block: editable source, with the rendered formula underneath.
 *
 * Same shape as the diagram fence in ../diagram — and for the same reason. The preview has
 * to be a *sibling* of the editable content, because hiding the source while the block is
 * unfocused would otherwise hide the formula with it.
 */
class MathBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  #preview: HTMLElement
  #source: string

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.#source = node.textContent

    this.dom = document.createElement('div')
    this.dom.className = 'md-math-block md-rawblock md-end-block'
    this.dom.setAttribute('data-type', 'math-block')

    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'md-rawblock-input'

    // Typora brackets the source with the `$$` lines it consumed, as .md-rawblock-before
    // and -after; lightmind styles both. They are generated, so they are marked as syntax
    // rather than content and share the source's reveal-on-focus rule.
    const before = fence('md-rawblock-before')
    const after = fence('md-rawblock-after')

    this.#preview = document.createElement('div')
    this.#preview.className = 'md-rawblock-container'
    this.#preview.contentEditable = 'false'

    // The source is hidden until the block has focus, so a click on the preview has no
    // visible text to land in and ProseMirror would put the caret beside the block rather
    // than inside it. Place it explicitly at the end of the source instead.
    this.#preview.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const pos = getPos()
      if (pos == null) return
      const size = view.state.doc.nodeAt(pos)?.content.size ?? 0
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1 + size)))
      view.focus()
    })

    this.dom.append(before, this.contentDOM, after, this.#preview)
    this.render()
  }

  render(): void {
    this.dom.dataset['value'] = this.#source
    if (!this.#source.trim()) {
      // An empty block is normal right after `$$` — bridge.css labels it rather than
      // leaving a formula-shaped hole in the document.
      this.#preview.replaceChildren()
      return
    }
    paint(this.#preview, this.#source, true, this)
  }

  update(node: Node): boolean {
    if (node.type.name !== BLOCK) return false
    const source = node.textContent
    if (source !== this.#source) {
      this.#source = source
      this.render()
    }
    return true
  }

  ignoreMutation(mutation: { target: globalThis.Node }): boolean {
    // The preview is generated; only the source is document content.
    return this.#preview.contains(mutation.target)
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof globalThis.Node && this.#preview.contains(event.target)
  }

  destroy(): void {
    pending.delete(this)
  }
}

/**
 * `$…$`: the rendered formula, until it is selected — then a field holding its TeX.
 *
 * ProseMirror calls selectNode/deselectNode when an atom becomes (or stops being) the
 * selection, which is exactly Typora's rule for when a formula opens for editing: click it,
 * or walk into it with the arrow keys.
 */
class MathInlineView implements NodeView {
  dom: HTMLElement
  #value: string
  #editing = false
  #input: HTMLElement | undefined
  #view: EditorView
  #getPos: () => number | undefined

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.#value = String(node.attrs['value'] ?? '')
    this.#view = view
    this.#getPos = getPos
    this.dom = document.createElement('span')
    this.dom.className = 'md-inline-math'
    this.dom.setAttribute('data-type', 'math-inline')
    this.dom.contentEditable = 'false'
    this.render()
  }

  render(): void {
    this.dom.dataset['value'] = this.#value
    if (this.#editing) return
    this.#input = undefined
    if (!this.#value.trim()) {
      // Nothing to typeset, and an empty span is unclickable — show the delimiters so
      // there is something to put the caret back into.
      this.dom.textContent = '$$'
      return
    }
    paint(this.dom, this.#value, false, this)
  }

  selectNode(): void {
    this.#editing = true
    pending.delete(this)
    this.dom.classList.add('md-expand')

    // Typora's own vocabulary: the delimiters are .md-meta, the source between them is
    // .md-content, and both are revealed by .md-expand on the container.
    const input = document.createElement('span')
    input.className = 'md-content md-expand'
    input.contentEditable = 'true'
    input.spellcheck = false
    input.textContent = this.#value

    const open = document.createElement('span')
    open.className = 'md-meta md-expand'
    open.textContent = '$'
    const close = open.cloneNode(true)

    input.addEventListener('input', () => this.#commit(input.textContent ?? ''))
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return
      // Both mean "done": put the caret back in the paragraph, after the formula.
      event.preventDefault()
      const pos = this.#getPos()
      if (pos == null) return
      const { state } = this.#view
      this.#view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos + 1)))
      this.#view.focus()
    })

    this.dom.replaceChildren(open, input, close)
    this.#input = input

    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    input.focus()
  }

  deselectNode(): void {
    this.#editing = false
    this.dom.classList.remove('md-expand')
    this.#commit(this.#input?.textContent ?? this.#value)
    this.render()
  }

  /** Write the edited TeX back to the document, so undo and save see every keystroke. */
  #commit(value: string): void {
    if (value === this.#value) return
    this.#value = value
    const pos = this.#getPos()
    if (pos == null) return
    const { state } = this.#view
    // Silent: this transaction *is* the edit the user just made, and re-rendering the
    // field they are typing in would drop the caret.
    this.#view.dispatch(state.tr.setNodeAttribute(pos, 'value', value))
  }

  update(node: Node): boolean {
    if (node.type.name !== INLINE) return false
    const value = String(node.attrs['value'] ?? '')
    if (value !== this.#value) {
      this.#value = value
      this.render()
    }
    return true
  }

  ignoreMutation(): boolean {
    return true
  }

  stopEvent(): boolean {
    // While editing, the field owns its keystrokes; otherwise nothing inside is editable
    // anyway and ProseMirror is welcome to the event.
    return this.#editing
  }

  destroy(): void {
    pending.delete(this)
  }
}

const mathViewPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('TYPORA_MATH'),
      props: {
        nodeViews: {
          [INLINE]: (node: Node, view: EditorView, getPos: () => number | undefined) =>
            new MathInlineView(node, view, getPos) as unknown as NodeView,
          [BLOCK]: (node: Node, view: EditorView, getPos: () => number | undefined) =>
            new MathBlockView(node, view, getPos) as unknown as NodeView,
        },
      },
    })
)

/**
 * The Markdown that produced a range — marks written back out as their delimiters.
 *
 * An input rule matches on flattened text, and by the time a formula closes some of it may
 * no longer be text: typing `$a^2+b^` fires the superscript rule first, so what the maths
 * rule sees is `a2+b2` with the carets living on as a mark. Typora survives this by
 * re-parsing the whole paragraph once the formula closes, and putting the delimiters back
 * is the same thing at the scale that matters here.
 */
function sourceText(doc: Node, from: number, to: number): string {
  let text = ''
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true
    const slice = (node.text ?? '').slice(Math.max(0, from - pos), Math.max(0, to - pos))
    if (!slice) return false
    text += node.marks.reduce((inner, mark) => {
      const delimiter = DELIMITERS[mark.type.name]
      return delimiter ? `${delimiter.open}${inner}${delimiter.close}` : inner
    }, slice)
    return false
  })
  return text
}

/*
 * `$x^2$` becomes a formula as soon as the closing `$` is typed.
 *
 * Both ends have to sit against the TeX — `$5 and $10` is money, not maths, and requiring
 * a non-space on each side is the rule Typora uses to tell the two apart. A single `$` on
 * its own is left alone, so `$$` can still open a block.
 */
export const mathInlineInputRule = $inputRule((ctx) =>
  new InputRule(/\$([^\s$][^$\n]*[^\s$]|[^\s$])\$$/, (state, match, start, end) => {
    // `start` is the opening `$`; the closing one is the keystroke that got us here and is
    // not in the document yet.
    const value = (sourceText(state.doc, start, end).replace(/^\$/, '') || match[1]) ?? ''
    if (!value.trim()) return null
    return state.tr.replaceWith(start, end, mathInlineSchema.type(ctx).create({ value }))
  })
)

/** `$$` then a space opens a block; `$$` then Enter does too — see ../block-enter.ts. */
export const mathBlockInputRule = $inputRule((ctx) =>
  textblockTypeInputRule(/^\$\$\s$/, mathBlockSchema.type(ctx))
)

export const math: MilkdownPlugin[] = [
  remarkMathPlugin,
  mathInlineSchema,
  mathBlockSchema,
  mathViewPlugin,
  mathInlineInputRule,
  mathBlockInputRule,
].flat()

export { loadKatex } from './katex-loader'
