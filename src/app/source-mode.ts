import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { Selection as ProseSelection } from '@milkdown/kit/prose/state'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

import type { DocumentState } from '../doc'
import type { DocumentViews } from '../doc/views'
import type { EditorHandle } from '../editor'
import {
  alignBlocks,
  renderedInnerOffset,
  renderedTextOffset,
  sourceBlocks,
  sourceKind,
  sourceMarkdown,
  sourceOffsetAt,
  textOffsetAt,
  visibleMap,
} from './source-map'

interface SourceViewState {
  state: EditorState
  scrollTop: number
  scrollLeft: number
}

/**
 * A caret in the rendered document, expressed so the source view can find the same spot.
 *
 * `textOffset` counts rendered characters within the block, which is the unit both sides
 * share. `kinds` is the block sequence it was measured against, so the pairing is done
 * against the document as it stood when the caret was read. `ratio` is only a fallback for
 * a block that pairs with nothing at all.
 */
interface RenderedAnchor {
  blockIndex: number
  textOffset: number
  ratio: number
  kinds: string[]
  viewportY: number
}

/** The same, in the other direction: `blockIndex` indexes the source blocks. */
interface SourceAnchor {
  blockIndex: number
  textOffset: number
  ratio: number
  kinds: string[]
  viewportY: number
}

export interface SourceMode {
  readonly isSource: boolean
  getMarkdown: () => string
  replace: (markdown: string) => void
  swap: (next: DocumentState, previous?: DocumentState) => void
  forget: (id: string) => void
  toggle: () => void
}

export interface SourceModeOptions {
  stage: HTMLElement
  content: HTMLElement
  editor: EditorHandle
  views: DocumentViews
  activeId: () => string
  onEdit: () => void
  onModeChange: () => void
}

/* CodeMirror-compatible names let the active Typora theme colour Markdown source too. */
const sourceHighlight = HighlightStyle.define([
  { tag: tags.heading, class: 'cm-header' },
  { tag: tags.quote, class: 'cm-quote' },
  { tag: tags.link, class: 'cm-link' },
  { tag: tags.strong, class: 'cm-strong' },
  { tag: tags.emphasis, class: 'cm-em' },
  { tag: tags.monospace, class: 'cm-string' },
  { tag: tags.comment, class: 'cm-comment' },
  { tag: tags.meta, class: 'cm-meta' },
  { tag: tags.keyword, class: 'cm-keyword' },
  { tag: tags.string, class: 'cm-string' },
  { tag: tags.number, class: 'cm-number' },
  { tag: tags.bool, class: 'cm-atom' },
  { tag: tags.tagName, class: 'cm-tag' },
  { tag: tags.attributeName, class: 'cm-attribute' },
])

const sourceTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--app-fg)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    fontSize: '14px',
    lineHeight: '22px',
    fontVariantLigatures: 'none',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: 'var(--app-source-padding)',
    caretColor: 'var(--app-fg)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--app-fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--app-fg) 22%, transparent)',
  },
})

/**
 * An editable, highlighted view of the active document's Markdown source.
 *
 * Highlighting, selection, caret placement and input all live in CodeMirror's one content
 * surface. This is intentionally not a transparent textarea over a separate pre: browsers
 * use different layout paths for those elements, so their glyph and selection geometry
 * cannot be kept reliably aligned at every zoom and DPI.
 */
export function createSourceMode(options: SourceModeOptions): SourceMode {
  const root = document.createElement('div')
  root.className = 'app-source'
  root.hidden = true

  const surface = document.createElement('div')
  surface.className = 'app-source__surface'
  root.appendChild(surface)
  options.stage.appendChild(root)

  let source = false
  let shownId = options.activeId()
  let renderedMarkdown = ''
  let sourceAtOpen = ''
  let internalChange = false
  let restoreFrame = 0
  const retained = new Map<string, SourceViewState>()
  const renderedBaselines = new Map<string, string>()

  const extensions = [
    sourceMarkdown.extension,
    syntaxHighlighting(sourceHighlight),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.contentAttributes.of({
      'aria-label': 'Markdown source',
      'aria-multiline': 'true',
      autocapitalize: 'off',
      autocomplete: 'off',
      class: 'app-source__input',
      spellcheck: 'false',
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !internalChange) options.onEdit()
    }),
    sourceTheme,
  ]

  const sourceView = new EditorView({
    state: EditorState.create({ doc: '', extensions }),
    parent: surface,
  })

  function markdownText(): string {
    return sourceView.state.doc.toString()
  }

  function renderedKinds(doc: ProseNode): string[] {
    const kinds: string[] = []
    for (let i = 0; i < doc.childCount; i += 1) kinds.push(doc.child(i).type.name)
    return kinds
  }

  function renderedPosition(): RenderedAnchor {
    let anchor: RenderedAnchor = {
      blockIndex: 0,
      textOffset: 0,
      ratio: 0,
      kinds: [],
      viewportY: options.stage.offsetTop,
    }
    options.editor.withView((view) => {
      const { doc, selection } = view.state
      if (!doc.childCount) return
      const blockIndex = Math.min(selection.$head.index(0), doc.childCount - 1)
      let blockStart = 0
      for (let i = 0; i < blockIndex; i += 1) blockStart += doc.child(i).nodeSize
      const block = doc.child(blockIndex)
      const innerOffset = Math.max(0, Math.min(selection.head - blockStart - 1, block.content.size))
      anchor = {
        blockIndex,
        textOffset: renderedTextOffset(block, innerOffset),
        ratio: block.content.size ? innerOffset / block.content.size : 0,
        kinds: renderedKinds(doc),
        viewportY: view.coordsAtPos(selection.head).top,
      }
    })
    return anchor
  }

  function sourceOffset(anchor: RenderedAnchor, state: EditorState): number {
    const text = state.doc.toString()
    const blocks = sourceBlocks(state, text)
    if (!blocks.length) return 0

    const pairs = alignBlocks(
      anchor.kinds,
      blocks.map((entry) => sourceKind(entry.name))
    )
    const paired = pairs[anchor.blockIndex]
    const block = blocks[paired ?? Math.min(anchor.blockIndex, blocks.length - 1)]
    if (!block) return 0
    if (paired == null) return Math.round(block.from + anchor.ratio * (block.to - block.from))
    return sourceOffsetAt(visibleMap(block, text), anchor.textOffset)
  }

  function sourceAnchor(): SourceAnchor {
    const state = sourceView.state
    const text = state.doc.toString()
    const head = state.selection.main.head
    const blocks = sourceBlocks(state, text)

    let blockIndex = blocks.findIndex((block) => block.from <= head && head <= block.to)
    if (blockIndex < 0) {
      blockIndex = blocks.findIndex((block) => block.from > head)
      if (blockIndex < 0) blockIndex = Math.max(0, blocks.length - 1)
    }
    const block = blocks[blockIndex]
    const length = block ? block.to - block.from : text.length
    return {
      blockIndex,
      textOffset: block ? textOffsetAt(visibleMap(block, text), head) : 0,
      ratio: block && length ? Math.max(0, Math.min(1, (head - block.from) / length)) : 0,
      kinds: blocks.map((entry) => sourceKind(entry.name)),
      viewportY: sourceView.coordsAtPos(head)?.top ?? options.stage.offsetTop,
    }
  }

  function revealRendered(anchor: SourceAnchor): void {
    const id = options.activeId()
    options.editor.withView((view) => {
      const { doc } = view.state
      if (!doc.childCount) return

      const pairs = alignBlocks(renderedKinds(doc), anchor.kinds)
      const paired = pairs.findIndex((sourceIndex) => sourceIndex === anchor.blockIndex)
      const blockIndex = paired >= 0 ? paired : Math.min(anchor.blockIndex, doc.childCount - 1)

      let blockStart = 0
      for (let i = 0; i < blockIndex; i += 1) blockStart += doc.child(i).nodeSize
      const block = doc.child(blockIndex)
      const innerOffset =
        paired >= 0
          ? renderedInnerOffset(block, anchor.textOffset)
          : Math.round(anchor.ratio * block.content.size)
      const target = Math.min(doc.content.size, blockStart + 1 + innerOffset)
      view.dispatch(view.state.tr.setSelection(ProseSelection.near(doc.resolve(target))))
      view.focus()
    })

    requestAnimationFrame(() => {
      if (source || options.activeId() !== id) return
      options.editor.withView((view) => {
        const top = view.coordsAtPos(view.state.selection.head).top
        options.content.scrollTop += top - anchor.viewportY
      })
    })
  }

  function capture(id: string): void {
    retained.set(id, {
      state: sourceView.state,
      scrollTop: sourceView.scrollDOM.scrollTop,
      scrollLeft: sourceView.scrollDOM.scrollLeft,
    })
  }

  function show(markdown: string, id: string, restoreKept = false, anchor?: RenderedAnchor): void {
    shownId = id
    const kept = retained.get(id)
    const state =
      kept && (restoreKept || kept.state.doc.toString() === markdown)
        ? kept.state
        : EditorState.create({ doc: markdown, extensions })
    sourceAtOpen = state.doc.toString()

    internalChange = true
    sourceView.setState(state)
    if (anchor) {
      sourceView.dispatch({ selection: { anchor: sourceOffset(anchor, state) } })
    }
    internalChange = false

    if (restoreFrame) cancelAnimationFrame(restoreFrame)
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = 0
      if (shownId !== id) return
      if (anchor) {
        const top = sourceView.coordsAtPos(sourceView.state.selection.main.head)?.top
        if (top != null) sourceView.scrollDOM.scrollTop += top - anchor.viewportY
      } else {
        sourceView.scrollDOM.scrollTop = kept?.scrollTop ?? 0
        sourceView.scrollDOM.scrollLeft = kept?.scrollLeft ?? 0
      }
      sourceView.requestMeasure()
    })
  }

  const controller: SourceMode = {
    get isSource() {
      return source
    },

    getMarkdown: () => (source ? markdownText() : options.editor.getMarkdown()),

    replace(markdown) {
      const id = options.activeId()
      retained.delete(id)
      renderedBaselines.delete(id)
      options.views.replace(markdown)
      if (source) {
        show(markdown, id)
        renderedMarkdown = options.editor.getMarkdown()
        renderedBaselines.set(id, renderedMarkdown)
      }
    },

    swap(next, previous) {
      if (!source) {
        options.views.swap(next, previous)
        return
      }

      if (previous) {
        capture(previous.id)
        // Keep the hidden ProseMirror state aligned before DocumentViews retains it.
        if (markdownText() !== sourceAtOpen) options.editor.setMarkdown(markdownText())
        renderedBaselines.set(previous.id, options.editor.getMarkdown())
      }
      options.views.swap(next, previous)
      renderedMarkdown = options.editor.getMarkdown()
      const restoreKept = renderedBaselines.get(next.id) === renderedMarkdown
      show(renderedMarkdown, next.id, restoreKept)
    },

    forget(id) {
      retained.delete(id)
      renderedBaselines.delete(id)
      options.views.forget(id)
    },

    toggle() {
      if (!source) {
        const id = options.activeId()
        const anchor = renderedPosition()
        renderedMarkdown = options.editor.getMarkdown()
        const restoreKept = renderedBaselines.get(id) === renderedMarkdown
        show(renderedMarkdown, id, restoreKept, anchor)
        source = true
        options.content.hidden = true
        root.hidden = false
        sourceView.requestMeasure()
        sourceView.focus()
      } else {
        const anchor = sourceAnchor()
        capture(options.activeId())
        const markdown = markdownText()
        source = false
        root.hidden = true
        options.content.hidden = false
        if (markdown !== sourceAtOpen) options.editor.setMarkdown(markdown)
        renderedMarkdown = options.editor.getMarkdown()
        renderedBaselines.set(options.activeId(), renderedMarkdown)
        revealRendered(anchor)
        // Parsing source may normalise it, so update dirty state against the text that the
        // rendered editor will actually save.
        options.onEdit()
      }
      options.onModeChange()
    },
  }

  return controller
}
