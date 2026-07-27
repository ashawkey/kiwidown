import { headingIdGenerator } from '@milkdown/kit/preset/commonmark'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { $nodeSchema, $prose, $remark } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { Node } from '@milkdown/kit/prose/model'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'
import type { Root, RootContent } from 'mdast'
import type { Plugin as UnifiedPlugin, Processor } from 'unified'

/*
 * `[TOC]` — Typora's table of contents.
 *
 * Rendered as Typora does, since nearly every vendored theme styles `.md-toc` and several
 * go further into `.md-toc-item` / `.md-toc-h1`:
 *
 *   <div class="md-toc md-end-block">
 *     <p class="md-toc-content">
 *       <span class="md-toc-item md-toc-h1"><a class="md-toc-inner">Heading</a></span>
 *       …
 *
 * The contents are derived from the document rather than stored, so the node itself is an
 * atom and its view re-renders whenever the headings change.
 */

const TOC_TYPE = 'toc'

/** `[TOC]` alone in a paragraph becomes a toc node; anywhere else it stays literal text. */
const remarkToc: UnifiedPlugin<[], Root> = function remarkToc(this: Processor) {
  const data = this.data() as { toMarkdownExtensions?: unknown[] }
  const extensions = (data.toMarkdownExtensions ??= [])
  extensions.push({ handlers: { [TOC_TYPE]: () => '[TOC]' } })

  return (tree: Root) => {
    tree.children = tree.children.map((node: RootContent) => {
      if (node.type !== 'paragraph' || node.children.length !== 1) return node
      const only = node.children[0]
      if (only?.type !== 'text' || only.value.trim() !== '[TOC]') return node
      return { type: TOC_TYPE } as unknown as RootContent
    })
  }
}

const remarkTocPlugin = $remark('typoraToc', () => remarkToc)

export const tocSchema = $nodeSchema(TOC_TYPE, () => ({
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  parseDOM: [{ tag: 'div.md-toc' }],
  toDOM: () => ['div', { class: 'md-toc md-end-block', 'data-type': TOC_TYPE }],
  parseMarkdown: {
    match: ({ type }) => type === TOC_TYPE,
    runner: (state, _node, type) => {
      state.addNode(type)
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === TOC_TYPE,
    runner: (state) => {
      state.addNode(TOC_TYPE)
    },
  },
}))

interface Entry {
  level: number
  text: string
  id: string
}

/** How a heading's anchor is spelled. See {@link collectHeadings}. */
type HeadingId = (node: Node) => string

/**
 * The headings, with the same anchors the headings themselves render with.
 *
 * `heading.attrs.id` is *not* that anchor: Milkdown defaults it to `''` and its
 * `parseMarkdown` runner never sets it, so for a document parsed from Markdown — which is
 * every document here — it stays empty. The id that reaches the DOM is generated inside the
 * heading's own `toDOM`, from `headingIdGenerator`. Reading the attribute instead gave every
 * entry an empty id, which left the links without an `href` and made the click handler ask
 * for `querySelector('#')` — a syntax error, thrown on every click.
 *
 * So the generator is consulted directly, exactly as the heading schema does, which is also
 * what stops the two spellings drifting apart.
 */
function collectHeadings(doc: Node, headingId: HeadingId): Entry[] {
  const entries: Entry[] = []
  doc.descendants((node) => {
    if (node.type.name !== 'heading') return true
    const text = node.textContent.trim()
    if (text) {
      const id = String(node.attrs['id'] ?? '') || headingId(node)
      entries.push({ level: Number(node.attrs['level']) || 1, text, id })
    }
    return false
  })
  return entries
}

/**
 * Cheap identity for "have the headings changed", used to avoid pointless re-renders.
 *
 * Joined on NUL because it is the one character heading text cannot contain, so no two
 * different sets of headings can spell the same signature.
 */
function signature(entries: Entry[]): string {
  return entries.map((e) => `${e.level}:${e.id}:${e.text}`).join('\u0000')
}

/*
 * Live views, so heading edits anywhere in the document update every TOC.
 *
 * A node view's `update` only fires when its own node changes, and a toc node never does —
 * its content comes from elsewhere in the document. So the views register here and the
 * plugin below nudges them.
 */
const liveViews = new Set<TocView>()

class TocView implements NodeView {
  dom: HTMLElement
  #view: EditorView
  #headingId: HeadingId
  #signature = '\u0000unset'

  constructor(view: EditorView, headingId: HeadingId) {
    this.#view = view
    this.#headingId = headingId
    this.dom = document.createElement('div')
    this.dom.className = 'md-toc md-end-block'
    this.dom.setAttribute('data-type', TOC_TYPE)
    // Generated content: editing it would have nothing to write back to.
    this.dom.contentEditable = 'false'
    liveViews.add(this)
    this.render()
  }

  render(): void {
    const entries = collectHeadings(this.#view.state.doc, this.#headingId)
    const next = signature(entries)
    if (next === this.#signature) return
    this.#signature = next

    const content = document.createElement('p')
    content.className = 'md-toc-content'

    for (const entry of entries) {
      const item = document.createElement('span')
      item.className = `md-toc-item md-toc-h${entry.level}`
      item.dataset['ref'] = entry.id

      const link = document.createElement('a')
      link.className = 'md-toc-inner'
      link.textContent = entry.text
      if (entry.id) {
        link.href = `#${entry.id}`
        link.addEventListener('click', (event) => {
          event.preventDefault()
          this.#view.dom.querySelector(`#${CSS.escape(entry.id)}`)?.scrollIntoView({ block: 'start' })
        })
      }

      item.appendChild(link)
      content.appendChild(item)
    }

    this.dom.replaceChildren(content)
  }

  // The contents are derived from the document, not part of it, so ProseMirror must not
  // read the panel's own DOM changes back as edits.
  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    liveViews.delete(this)
  }
}

const tocViewPlugin = $prose((ctx) => {
  // The same slice the heading schema reads, so a TOC entry's anchor and the heading's own
  // id are generated by one function rather than two that agree today.
  const headingId = ctx.get(headingIdGenerator.key)
  return new Plugin({
    key: new PluginKey('TYPORA_TOC'),
    props: {
      nodeViews: {
        [TOC_TYPE]: (_node, view) => new TocView(view, headingId),
      },
    },
    view: () => ({
      update: (view, prevState) => {
        // Only when the document actually changed; heading text is the only input.
        if (prevState.doc === view.state.doc) return
        for (const tocView of liveViews) tocView.render()
      },
    }),
  })
})

export const toc: MilkdownPlugin[] = [remarkTocPlugin, tocSchema, tocViewPlugin].flat()
