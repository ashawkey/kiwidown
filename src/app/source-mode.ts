import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { Selection as ProseSelection } from '@milkdown/kit/prose/state'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

import type { DocumentState } from '../doc'
import type { DocumentViews } from '../doc/views'
import type { EditorHandle } from '../editor'
import { THEME_CHANGE_EVENT } from '../theme'
import {
  dedentListItem,
  indentListItem,
  insertNewlineContinueMarkup,
  sourceFolding,
} from './source-commands'
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
  /** Only the vertical offset: the source column wraps, so it never scrolls sideways. */
  scrollTop: number
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
  insertTable: (rows: number, columns: number) => void
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

/* Keep CodeMirror-compatible token names for DOM inspection and theme interoperability. */
const sourceClasses = HighlightStyle.define([
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

/* The Lezer Markdown grammar supplies these tags. CSS variables switch with the app's
   light/dark signal without rebuilding the editor state. */
const sourceColors = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--app-syntax-heading)', fontWeight: '600' },
  { tag: tags.quote, color: 'var(--app-syntax-quote)', fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--app-syntax-link)' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.monospace, color: 'var(--app-syntax-code)' },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: 'var(--app-syntax-markup)' },
  { tag: tags.comment, color: 'var(--app-syntax-quote)' },
  { tag: [tags.keyword, tags.tagName], color: 'var(--app-syntax-keyword)' },
  { tag: [tags.string, tags.attributeName], color: 'var(--app-syntax-string)' },
  { tag: [tags.number, tags.bool, tags.atom], color: 'var(--app-syntax-code)' },
])

/** The rendered document's reading column, from shell.css. */
const COLUMN = 'max(var(--app-doc-width), min(100%, var(--app-doc-measure)))'

/** The chrome's own inset, so panels line up with the column the scroller paints. */
const COLUMN_INSET = `max(var(--app-source-inset), calc((100% - ${COLUMN}) / 2))`

const sourceTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--app-fg)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },
  /*
   * The column is inline padding on the scroller rather than a width on the content, so the
   * line-number gutter — a flex sibling of the content, pinned to the scroller's inline
   * start — sits inside the column instead of out at the window edge.
   *
   * Sizes are explicit px like the rest of the chrome, since themes reset the root size;
   * --app-font-scale is how the font-size control reaches them (see display-controls.ts).
   */
  '.cm-scroller': {
    overflow: 'auto',
    paddingInline: COLUMN_INSET,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    fontSize: 'calc(14px * var(--app-font-scale, 1))',
    lineHeight: 'calc(22px * var(--app-font-scale, 1))',
    fontVariantLigatures: 'none',
  },
  '.cm-content': {
    flex: '1 1 auto',
    minWidth: '0',
    minHeight: '100%',
    paddingBlock: 'var(--app-source-padding)',
    caretColor: 'var(--app-fg)',
  },
  '.cm-line': { padding: '0' },
  // No background or border of its own: numbers in the document's own margin, not a panel.
  // Their vertical offset comes from the content's padding, so the gutter adds none.
  '.cm-gutters': {
    border: 'none',
    background: 'transparent',
    color: 'var(--app-fg-dim)',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 12px 0 0',
    minWidth: '3ch',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px 0 0', cursor: 'pointer' },
  // The markers are chrome, not text. An unfolded one only earns its place under the pointer;
  // a folded one has to stay visible, since it is the only sign anything is hidden.
  '.app-source__fold': { opacity: '0', transition: 'opacity 120ms' },
  '.cm-gutters:hover .app-source__fold, .app-source__fold.is-folded': { opacity: '0.6' },
  '.cm-foldPlaceholder': {
    margin: '0 4px',
    padding: '0 6px',
    border: '1px solid var(--app-border)',
    borderRadius: '4px',
    background: 'var(--app-hover)',
    color: 'var(--app-fg-dim)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--app-fg) 4%, transparent)' },
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--app-fg)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--app-fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--app-fg) 22%, transparent)',
  },
  // Matched through .cm-content, which the extensions' own light/dark rules do not do, so
  // these win on specificity and can then follow the app's light/dark signal instead.
  '.cm-content .cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--app-syntax-link) 18%, transparent)',
  },
  '.cm-content .cm-searchMatch': { backgroundColor: 'var(--app-match)' },
  '.cm-content .cm-searchMatch-selected': { backgroundColor: 'var(--app-match-active)' },
  // A hard line break is two spaces nobody can see, and a non-breaking space parses as a
  // letter. Mark the space itself rather than colouring text that looks perfectly normal.
  '.cm-trailingSpace': {
    backgroundColor: 'color-mix(in srgb, var(--app-syntax-keyword) 18%, transparent)',
    borderRadius: '2px',
  },
  '.cm-specialChar': {
    color: 'var(--app-syntax-keyword)',
    background: 'color-mix(in srgb, var(--app-syntax-keyword) 12%, transparent)',
  },
  /*
   * The find panel, which CodeMirror puts in a slot of its own outside the scroller: it needs
   * the chrome's type and colours, since the surface's monospace and --app-font-scale stop at
   * the scroller, and the column's inset, to line up with the text it searches.
   *
   * The selectors carry .cm-panel as well, to outrank the search extension's own base theme.
   */
  '.cm-panels': {
    border: 'none',
    background: 'transparent',
    color: 'var(--app-fg)',
    font: '13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--app-border)' },
  '.cm-panel.cm-search': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    padding: `8px ${COLUMN_INSET}`,
    background: 'var(--app-bg)',
  },
  '.cm-panel.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    margin: '0',
    fontSize: '92%',
    color: 'var(--app-fg-dim)',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    margin: '0',
    font: 'inherit',
    color: 'var(--app-fg)',
  },
  '.cm-textfield': {
    minWidth: '12ch',
    padding: '3px 6px',
    border: '1px solid var(--app-border)',
    borderRadius: '5px',
    background: 'var(--app-bg)',
  },
  '.cm-textfield:focus-visible': { outline: '2px solid var(--app-syntax-link)' },
  '.cm-button': {
    padding: '3px 8px',
    border: '1px solid var(--app-border)',
    borderRadius: '5px',
    background: 'var(--app-bg)',
    backgroundImage: 'none',
    cursor: 'pointer',
  },
  '.cm-button:hover': { background: 'var(--app-hover)' },
  // Absolutely positioned by the extension. Pulled in to the column's edge, where the text
  // it closes over ends, rather than the window's.
  '.cm-panel.cm-search button[name="close"]': {
    top: '6px',
    right: COLUMN_INSET,
    padding: '0 4px',
    border: 'none',
    background: 'transparent',
    color: 'var(--app-fg-dim)',
    fontSize: '18px',
    lineHeight: '1',
    cursor: 'pointer',
  },
})

/** A fold arrow, classed so the theme above can hide the ones that are not folded. */
function foldMarker(open: boolean): HTMLElement {
  const marker = document.createElement('span')
  marker.className = open ? 'app-source__fold' : 'app-source__fold is-folded'
  marker.title = open ? 'Fold section' : 'Unfold section'
  marker.textContent = open ? '⌄' : '›'
  return marker
}

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
    syntaxHighlighting(sourceClasses),
    syntaxHighlighting(sourceColors),
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    sourceFolding,
    foldGutter({ markerDOM: foldMarker }),
    // Markdown lines are prose, and a paragraph is one line: wrapping, not a horizontal
    // scrollbar. Also what keeps the source column the same shape as the rendered one.
    EditorView.lineWrapping,
    // Whitespace that changes what Markdown means but cannot be seen: two trailing spaces
    // are a hard line break, and a non-breaking space pasted in from a web page or a word
    // processor stops a marker, a fence or a table from parsing at all.
    highlightTrailingWhitespace(),
    // Non-breaking, figure, narrow and word-joiner spaces; the zero-width ones and the
    // byte-order mark are already in the extension's own set.
    highlightSpecialChars({ addSpecialChars: /[\u00a0\u2007\u202f\u2060]/g }),
    // CodeMirror draws the selection itself, which is what lets there be more than one.
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    EditorState.allowMultipleSelections.of(true),
    highlightSelectionMatches(),
    search({ top: true }),
    history(),
    // Ahead of the default keymap, and each of these declines the key when the caret is not
    // somewhere it applies, leaving the default binding to run.
    keymap.of([
      { key: 'Enter', run: insertNewlineContinueMarkup },
      { key: 'Tab', run: indentListItem },
      { key: 'Shift-Tab', run: dedentListItem },
    ]),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
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
    // A dropped file belongs to the app, which opens it in its own tab (see bindFileDrop).
    // CodeMirror's own drop handler would read it as text and paste it into this document.
    EditorView.domEventHandlers({
      drop: (event) => Boolean(event.dataTransfer?.files.length),
    }),
    sourceTheme,
  ]

  const sourceView = new EditorView({
    state: EditorState.create({ doc: '', extensions }),
    parent: surface,
  })

  // CodeMirror caches line heights and only watches its scroller for resizes, which the
  // font-size control does not change — it moves --app-font-scale and fires this event.
  window.addEventListener(THEME_CHANGE_EVENT, () => sourceView.requestMeasure())

  function markdownText(): string {
    return sourceView.state.doc.toString()
  }

  function insertSourceTable(rows: number, columns: number): void {
    const selection = sourceView.state.selection.main
    const before = sourceView.state.sliceDoc(0, selection.from)
    const after = sourceView.state.sliceDoc(selection.to)
    const emptyRow = `| ${Array(columns).fill('').join(' | ')} |`
    const delimiter = `| ${Array(columns).fill('---').join(' | ')} |`
    const table = [emptyRow, delimiter, ...Array(rows - 1).fill(emptyRow)].join('\n')
    const leading = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
    const trailing = after.length === 0 ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
    const inserted = `${leading}${table}${trailing}`

    sourceView.dispatch({
      changes: { from: selection.from, to: selection.to, insert: inserted },
      selection: { anchor: selection.from + leading.length + 2 },
      scrollIntoView: true,
    })
    sourceView.focus()
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
    retained.set(id, { state: sourceView.state, scrollTop: sourceView.scrollDOM.scrollTop })
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

    insertTable(rows, columns) {
      if (source) insertSourceTable(rows, columns)
      else options.editor.insertTable(rows, columns)
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
