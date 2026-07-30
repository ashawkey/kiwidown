import { foldService, syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'

/**
 * Markdown-aware editing for source mode: continuing list markup on Enter, moving a list
 * item between levels with Tab, and folding a heading's section.
 *
 * Deliberately written here rather than taken from `@codemirror/lang-markdown`, whose
 * commands come attached to its own Markdown language — which configures embedded HTML and
 * so pulls the HTML, JavaScript and CSS grammars into the bundle. Source mode parses with
 * the configuration in source-map.ts instead, and needs none of that.
 */

/**
 * A list item's opening: indent, marker, the space after it, and a task box if present.
 *
 * Ordered markers accept `)` as well as `.`, which CommonMark allows. The space after the
 * marker is required: `-word` is a paragraph, not a bullet.
 */
const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/

/** Any number of blockquote markers, which nest and can wrap a list. */
const QUOTE = /^(?:[ \t]*>)+[ \t]?/

interface ListItem {
  /** Everything before the item's text, as it should be re-typed on the next line. */
  continuation: string
  /** The column the item's text begins at, counted from the start of the line. */
  contentColumn: number
  /** The column the marker begins at. */
  indent: number
}

function parseListItem(text: string): ListItem | null {
  const match = LIST_ITEM.exec(text)
  if (!match) return null
  const indent = match[1] ?? ''
  const ordered = match[3]
  // The next ordered item counts on; a checked box does not continue as a checked one.
  const marker = match[2] ?? `${Number(ordered) + 1}${match[4] ?? '.'}`
  return {
    continuation: `${indent}${marker}${match[5] ?? ' '}${match[6] ? '[ ] ' : ''}`,
    contentColumn: match[0].length,
    indent: indent.length,
  }
}

/** Splits a line into its blockquote prefix and the content that prefix introduces. */
function splitQuote(text: string): { quote: string; rest: string } {
  const quote = QUOTE.exec(text)?.[0] ?? ''
  return { quote, rest: text.slice(quote.length) }
}

function leadingWidth(text: string): number {
  return text.length - text.trimStart().length
}

/**
 * Inside a fence, a line beginning `- ` is that language's syntax — a YAML sequence, a diff —
 * and none of the list handling below applies to it.
 */
function inCodeBlock(state: EditorState, pos: number): boolean {
  const name = blockAt(state, pos).name
  return name === 'FencedCode' || name === 'CodeBlock'
}

/**
 * Enter, continuing whatever markup the line opened: list markers, task boxes and
 * blockquotes. On an item with no text of its own it clears the markup instead, which is how
 * a list ends without reaching for the mouse.
 *
 * Returns false for anything else — a paragraph, a fence, a table — so that the default
 * keymap's Enter handles it.
 */
export const insertNewlineContinueMarkup: Command = (view) => {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false

  const line = state.doc.lineAt(range.head)
  const { quote, rest } = splitQuote(line.text)
  const item = parseListItem(rest)
  if (!quote && !item) return false
  if (inCodeBlock(state, line.from)) return false

  // Splitting the markup itself in half is never what was meant, so only continue when the
  // caret is past it.
  if (range.head - line.from < quote.length + (item?.contentColumn ?? 0)) return false

  const empty = item ? !rest.slice(item.contentColumn).trim() : !rest.trim()
  if (empty) {
    // The caret stays on this line, now blank apart from any quote around it, rather than
    // opening another item nobody asked for.
    const insert = item ? quote : ''
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
      userEvent: 'input',
    })
    return true
  }

  const insert = `\n${quote}${item?.continuation ?? ''}`
  view.dispatch({
    changes: { from: range.head, insert },
    selection: { anchor: range.head + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

/**
 * The column an item at `indent` nests to: where the text of the item above it at its own
 * level starts. Null when there is nothing there for it to become a child of.
 */
function nestColumn(state: EditorState, lineNumber: number, indent: number): number | null {
  for (let n = lineNumber - 1; n >= 1; n -= 1) {
    const { rest } = splitQuote(state.doc.line(n).text)
    if (!rest.trim()) continue
    const width = leadingWidth(rest)
    if (width > indent) continue // a deeper item, or one of its continuation lines
    const above = parseListItem(rest)
    // Level with us it is a sibling to nest under; anything further out is our own parent,
    // and a line that is not an item at all is where the list began.
    return above && width === indent ? above.contentColumn : null
  }
  return null
}

/** The column an item at `indent` outdents to: its parent's indent, or flush left. */
function outdentColumn(state: EditorState, lineNumber: number, indent: number): number {
  for (let n = lineNumber - 1; n >= 1; n -= 1) {
    const { rest } = splitQuote(state.doc.line(n).text)
    if (!rest.trim()) continue
    const width = leadingWidth(rest)
    if (width >= indent) continue
    return parseListItem(rest) ? width : 0
  }
  return 0
}

/**
 * Tab and Shift-Tab on a list item, moving it one level in or out.
 *
 * A level is where the neighbouring item's text starts, so the item lines up under it — that
 * alignment is what makes it a child list in Markdown, and it is what a fixed two-space
 * indent unit gets wrong under a `10. ` marker.
 */
function moveListItem(view: EditorView, outward: boolean): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false

  const line = state.doc.lineAt(range.head)
  const { quote, rest } = splitQuote(line.text)
  const item = parseListItem(rest)
  if (!item) return false
  if (outward && !item.indent) return false
  if (inCodeBlock(state, line.from)) return false

  const column = outward
    ? outdentColumn(state, line.number, item.indent)
    : nestColumn(state, line.number, item.indent)
  if (column == null) return false

  const from = line.from + quote.length
  view.dispatch({
    changes: { from, to: from + item.indent, insert: ' '.repeat(column) },
    userEvent: outward ? 'delete.dedent' : 'input.indent',
  })
  return true
}

export const indentListItem: Command = (view) => moveListItem(view, false)
export const dedentListItem: Command = (view) => moveListItem(view, true)

const HEADING = /^(?:ATX|Setext)Heading(\d)$/

/** The document-level block that starts at `pos`, which is what folds as a unit. */
function blockAt(state: EditorState, pos: number) {
  let node = syntaxTree(state).resolveInner(pos, 1)
  while (node.parent?.parent) node = node.parent
  return node
}

/**
 * Folding by section: a heading takes everything up to the next heading of the same or a
 * higher level, and a fenced block folds to its closing fence.
 *
 * Markdown has no brackets to fold on, so `@lezer/markdown` ships no fold information and
 * this has to come from the block structure instead. Ranges start at the end of the opening
 * line, so a folded section still reads as its own title.
 */
export const sourceFolding: Extension = foldService.of((state, lineStart, lineEnd) => {
  const node = blockAt(state, lineStart)
  if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
    return node.to > lineEnd ? { from: lineEnd, to: node.to } : null
  }

  const level = Number(HEADING.exec(node.name)?.[1])
  if (!level) return null

  let end = state.doc.length
  for (let next = node.nextSibling; next; next = next.nextSibling) {
    const nextLevel = Number(HEADING.exec(next.name)?.[1])
    if (!nextLevel || nextLevel > level) continue
    // Stop above the blank lines that separate the sections, so unfolding cannot appear to
    // move the next heading.
    let line = state.doc.lineAt(next.from)
    while (line.number > 1 && !state.doc.line(line.number - 1).text.trim()) {
      line = state.doc.line(line.number - 1)
    }
    end = line.from - 1
    break
  }

  // A setext heading is two lines, and folds from under its underline.
  const from = node.name.startsWith('Setext') ? Math.max(lineEnd, node.to) : lineEnd
  return end > from ? { from, to: end } : null
})
