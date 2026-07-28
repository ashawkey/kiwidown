import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  defineLanguageFacet,
  HighlightStyle,
  Language,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { Emoji, GFM, parser, Subscript, Superscript } from '@lezer/markdown'
import { Selection as ProseSelection } from '@milkdown/kit/prose/state'

import type { DocumentState } from '../doc'
import type { DocumentViews } from '../doc/views'
import type { EditorHandle } from '../editor'

interface SourceViewState {
  state: EditorState
  scrollTop: number
  scrollLeft: number
}

interface LogicalPosition {
  blockIndex: number
  ratio: number
  codeOffset?: number
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

const sourceMarkdown = new Language(
  defineLanguageFacet(),
  parser.configure([GFM, Subscript, Superscript, Emoji]),
  [],
  'markdown'
)

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

  function sourceBlocks(state = sourceView.state): Array<ReturnType<typeof syntaxTree>['topNode']> {
    const blocks: Array<ReturnType<typeof syntaxTree>['topNode']> = []
    for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
      blocks.push(node)
    }
    return blocks
  }

  function renderedPosition(): LogicalPosition {
    let position: LogicalPosition = { blockIndex: 0, ratio: 0, viewportY: options.stage.offsetTop }
    options.editor.withView((view) => {
      const { doc, selection } = view.state
      const blockIndex = Math.min(selection.$head.index(0), Math.max(0, doc.childCount - 1))
      let blockStart = 0
      for (let i = 0; i < blockIndex; i += 1) blockStart += doc.child(i).nodeSize
      const block = doc.child(blockIndex)
      const innerOffset = Math.max(0, selection.head - blockStart - 1)
      position = {
        blockIndex,
        ratio: block.content.size ? Math.min(1, innerOffset / block.content.size) : 0,
        codeOffset: block.type.name === 'code_block' ? innerOffset : undefined,
        viewportY: view.coordsAtPos(selection.head).top,
      }
    })
    return position
  }

  function sourceOffset(position: LogicalPosition, state: EditorState): number {
    const blocks = sourceBlocks(state)
    const block = blocks[Math.min(position.blockIndex, Math.max(0, blocks.length - 1))]
    if (!block) return Math.round(position.ratio * state.doc.length)

    if (position.codeOffset != null && block.name === 'FencedCode') {
      const contentStart = state.doc.toString().indexOf('\n', block.from) + 1
      if (contentStart > 0) return Math.min(block.to, contentStart + position.codeOffset)
    }
    return Math.round(block.from + position.ratio * (block.to - block.from))
  }

  function sourcePosition(): LogicalPosition {
    const head = sourceView.state.selection.main.head
    const blocks = sourceBlocks()
    let blockIndex = blocks.findIndex((block) => block.from <= head && head <= block.to)
    if (blockIndex < 0) {
      blockIndex = blocks.findIndex((block) => block.from > head)
      if (blockIndex < 0) blockIndex = Math.max(0, blocks.length - 1)
    }
    const block = blocks[blockIndex]
    const length = block ? block.to - block.from : sourceView.state.doc.length
    const ratio = block && length ? Math.max(0, Math.min(1, (head - block.from) / length)) : 0
    let codeOffset: number | undefined
    if (block?.name === 'FencedCode') {
      const contentStart = markdownText().indexOf('\n', block.from) + 1
      if (contentStart > 0) codeOffset = Math.max(0, head - contentStart)
    }
    return {
      blockIndex,
      ratio,
      codeOffset,
      viewportY: sourceView.coordsAtPos(head)?.top ?? options.stage.offsetTop,
    }
  }

  function revealRendered(position: LogicalPosition): void {
    const id = options.activeId()
    options.editor.withView((view) => {
      const blockIndex = Math.min(position.blockIndex, Math.max(0, view.state.doc.childCount - 1))
      let blockStart = 0
      for (let i = 0; i < blockIndex; i += 1) blockStart += view.state.doc.child(i).nodeSize
      const block = view.state.doc.child(blockIndex)
      const innerOffset =
        position.codeOffset != null && block.type.name === 'code_block'
          ? Math.min(position.codeOffset, block.content.size)
          : Math.round(position.ratio * block.content.size)
      const target = Math.min(view.state.doc.content.size, blockStart + 1 + innerOffset)
      view.dispatch(view.state.tr.setSelection(ProseSelection.near(view.state.doc.resolve(target))))
      view.focus()
    })

    requestAnimationFrame(() => {
      if (source || options.activeId() !== id) return
      options.editor.withView((view) => {
        const top = view.coordsAtPos(view.state.selection.head).top
        options.content.scrollTop += top - position.viewportY
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

  function show(
    markdown: string,
    id: string,
    restoreKept = false,
    position?: LogicalPosition
  ): void {
    shownId = id
    const kept = retained.get(id)
    const state =
      kept && (restoreKept || kept.state.doc.toString() === markdown)
        ? kept.state
        : EditorState.create({ doc: markdown, extensions })
    sourceAtOpen = state.doc.toString()

    internalChange = true
    sourceView.setState(state)
    if (position) {
      sourceView.dispatch({ selection: { anchor: sourceOffset(position, state) } })
    }
    internalChange = false

    if (restoreFrame) cancelAnimationFrame(restoreFrame)
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = 0
      if (shownId !== id) return
      if (position) {
        const top = sourceView.coordsAtPos(sourceView.state.selection.main.head)?.top
        if (top != null) sourceView.scrollDOM.scrollTop += top - position.viewportY
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
        const position = renderedPosition()
        renderedMarkdown = options.editor.getMarkdown()
        const restoreKept = renderedBaselines.get(id) === renderedMarkdown
        show(renderedMarkdown, id, restoreKept, position)
        source = true
        options.content.hidden = true
        root.hidden = false
        sourceView.requestMeasure()
        sourceView.focus()
      } else {
        const position = sourcePosition()
        capture(options.activeId())
        const markdown = markdownText()
        source = false
        root.hidden = true
        options.content.hidden = false
        if (markdown !== sourceAtOpen) options.editor.setMarkdown(markdown)
        renderedMarkdown = options.editor.getMarkdown()
        renderedBaselines.set(options.activeId(), renderedMarkdown)
        revealRendered(position)
        // Parsing source may normalise it, so update dirty state against the text that the
        // rendered editor will actually save.
        options.onEdit()
      }
      options.onModeChange()
    },
  }

  return controller
}
