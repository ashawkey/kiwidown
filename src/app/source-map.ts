import { defineLanguageFacet, ensureSyntaxTree, Language, syntaxTree } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { Emoji, GFM, parser, Subscript, Superscript } from '@lezer/markdown'
import type { EditorState } from '@codemirror/state'
import type { MarkdownConfig } from '@lezer/markdown'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

/*
 * Mapping the caret between the rendered document and its Markdown source.
 *
 * The two sides count different things. ProseMirror's positions run over rendered content:
 * `**bold**` contributes four characters of markup that do not exist there, an image is a
 * single atom regardless of how long its URL is, and a table's alignment row has no
 * counterpart at all. Interpolating between the two coordinate spaces by ratio only agrees
 * at a block's endpoints — in between it drifts by roughly the markup preceding the caret,
 * which is why a bold word used to be enough to move the caret a few characters and a link
 * or a table enough to move it much further.
 *
 * So instead of interpolating, both sides are reduced to the one thing they agree on: the
 * plain text a reader sees. `visibleMap` walks the Lezer tree and records, for each
 * character of that text, the source offset it came from; ProseMirror hands out the same
 * text through `textBetween`. Mapping in either direction is then a lookup, not an estimate.
 */

const DOLLAR = 36
const EQUALS = 61

/** `==text==` → a `<mark>`, via ../editor/typora-inline. */
const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: tags.special(tags.content) },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS) return -1
        const close = cx.slice(pos + 2, cx.end).indexOf('==')
        if (close <= 0) return -1
        const to = pos + 4 + close
        return cx.addElement(
          cx.elt('Highlight', pos, to, [
            cx.elt('HighlightMark', pos, pos + 2),
            cx.elt('HighlightMark', to - 2, to),
          ])
        )
      },
    },
  ],
}

/** `$x$` → a math node, via ../editor/math and remark-math. */
const InlineMath: MarkdownConfig = {
  defineNodes: [{ name: 'InlineMath', style: tags.special(tags.content) }],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1
        let open = pos
        while (cx.char(open) === DOLLAR) open += 1
        const width = open - pos
        // As in remark-math, the run that closes has to be exactly as long as the one that
        // opened, so `$$` inside `$…$` is content rather than a terminator.
        const rest = cx.slice(open, cx.end)
        const match = new RegExp(`(?<!\\$)\\${'$'.repeat(width)}(?!\\$)`).exec(rest)
        if (!match || match.index === 0) return -1
        return cx.addElement(cx.elt('InlineMath', pos, open + match.index + width))
      },
    },
  ],
}

/*
 * The parser the source view highlights with, and the one `visibleMap` walks below. They
 * have to be one and the same: the map's idea of which nodes are markup only holds for the
 * extensions actually enabled here, and every construct the rendered editor understands but
 * this parser does not is markup the map would miscount as text.
 */
export const sourceMarkdown = new Language(
  defineLanguageFacet(),
  parser.configure([GFM, Subscript, Superscript, Emoji, Highlight, InlineMath]),
  [],
  'markdown'
)

type SourceNode = ReturnType<typeof syntaxTree>['topNode']

export interface SourceBlock {
  name: string
  from: number
  to: number
  /** Absent for front matter, which is recognised without the parser's help. */
  node: SourceNode | null
  /** Set when the block's rendered text is a verbatim slice of the source. */
  contentFrom?: number
  contentTo?: number
}

/** Source characters that carry no rendered text. */
const MARKUP = new Set([
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'TaskMarker',
  'EmphasisMark',
  'StrikethroughMark',
  'SubscriptMark',
  'SuperscriptMark',
  'CodeMark',
  'CodeInfo',
  'LinkMark',
  'LinkLabel',
  'LinkTitle',
  'URL',
  'TableDelimiter',
  'HighlightMark',
])

/** Markers that also swallow the whitespace separating them from their content. */
const SPACED_MARKUP = new Set(['HeaderMark', 'QuoteMark', 'ListMark', 'TaskMarker'])

/** Rendered as a single atom holding no text of its own — the formula and the URL are attrs. */
const ATOMS = new Set(['Image', 'InlineMath'])

/*
 * Collapsed to a fixed number of rendered characters. Escapes and entities resolve to one.
 * remark-gemoji resolves `:shortcode:` to the emoji itself, and the great majority of those
 * sit outside the BMP, so two UTF-16 units is the right guess — a rare single-unit emoji
 * costs one character of accuracy for carets later in the same block.
 */
const COLLAPSED = new Map([
  ['Escape', 1],
  ['Entity', 1],
  ['Emoji', 2],
])

/** Blocks whose children are themselves blocks: the whitespace between them is structural. */
const CONTAINERS = new Set([
  'Blockquote',
  'BulletList',
  'OrderedList',
  'ListItem',
  'Table',
  'TableHeader',
  'TableRow',
])

const CODE = new Set(['FencedCode', 'CodeBlock'])

/*
 * remark-frontmatter is loaded in the rendered editor but there is no Lezer equivalent, so
 * the source parser reads `---\ntitle: x\n---` as a horizontal rule followed by a setext
 * heading — two blocks where ProseMirror has one, which shifted every block index in the
 * document after it. Front matter only ever appears at offset 0 and its closing fence is
 * mandatory, so recognising it here is both cheap and exactly as strict as remark is.
 */
const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

/** Coarse kind shared by both sides, used to pair blocks up. */
const KINDS: Record<string, string> = {
  Frontmatter: 'front_matter',
  Paragraph: 'paragraph',
  ATXHeading1: 'heading',
  ATXHeading2: 'heading',
  ATXHeading3: 'heading',
  ATXHeading4: 'heading',
  ATXHeading5: 'heading',
  ATXHeading6: 'heading',
  SetextHeading1: 'heading',
  SetextHeading2: 'heading',
  Blockquote: 'blockquote',
  BulletList: 'bullet_list',
  OrderedList: 'ordered_list',
  FencedCode: 'code_block',
  CodeBlock: 'code_block',
  Table: 'table',
  HorizontalRule: 'hr',
}

export function sourceKind(name: string): string {
  return KINDS[name] ?? name
}

/**
 * The document's top-level blocks, with front matter folded back into one.
 *
 * Forces the parse to complete first: `syntaxTree` returns whatever has been parsed so far,
 * and a tree truncated at the parse frontier would silently misalign every block past it.
 */
export function sourceBlocks(state: EditorState, text: string): SourceBlock[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state)
  const blocks: SourceBlock[] = []

  let parsedFrom = 0
  const front = FRONT_MATTER.exec(text)
  if (front) {
    const contentFrom = text.indexOf('\n') + 1
    parsedFrom = front[0].length
    blocks.push({
      name: 'Frontmatter',
      from: 0,
      to: parsedFrom,
      node: null,
      contentFrom,
      contentTo: contentFrom + (front[1]?.length ?? 0),
    })
  }

  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.from < parsedFrom) continue
    blocks.push({ name: node.name, from: node.from, to: node.to, node })
  }
  return blocks
}

interface Span {
  from: number
  to: number
  /** How many rendered characters this span accounts for. */
  visible: number
}

function collectSpans(node: SourceNode, text: string, out: Span[]): void {
  const name = node.name

  if (MARKUP.has(name)) {
    // The destination of a link is markup; the target of an autolink is its own text.
    if (name === 'URL' && node.parent?.name === 'Autolink') return
    let to = node.to
    if (SPACED_MARKUP.has(name)) {
      while (to < text.length && (text[to] === ' ' || text[to] === '\t')) to += 1
    }
    out.push({ from: node.from, to, visible: 0 })
    return
  }

  if (ATOMS.has(name)) {
    out.push({ from: node.from, to: node.to, visible: 0 })
    return
  }

  if (name === 'HardBreak') {
    // The line ending belongs to the break, which renders as a node rather than as text.
    let to = node.to
    while (to < text.length && (text[to] === ' ' || text[to] === '\t')) to += 1
    if (text[to] === '\r') to += 1
    if (text[to] === '\n') to += 1
    out.push({ from: node.from, to, visible: 0 })
    return
  }

  const collapsed = COLLAPSED.get(name)
  if (collapsed != null) {
    out.push({ from: node.from, to: node.to, visible: collapsed })
    return
  }

  const children: SourceNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child)

  /*
   * Only a link's text survives. Naming the individual markers is not enough — the space
   * between a destination and its title sits between them rather than inside either — so
   * everything outside the first two brackets is markup, whatever it happens to be.
   */
  if (name === 'Link') {
    const marks = children.filter((child) => child.name === 'LinkMark')
    const open = marks[0]
    const close = marks[1]
    if (open && close) {
      out.push({ from: node.from, to: open.to, visible: 0 })
      out.push({ from: close.from, to: node.to, visible: 0 })
      for (const child of children) {
        if (child.from >= open.to && child.to <= close.from) collectSpans(child, text, out)
      }
      return
    }
  }

  if (CONTAINERS.has(name)) {
    let pos = node.from
    for (const child of children) {
      if (child.from > pos) out.push({ from: pos, to: child.from, visible: 0 })
      pos = Math.max(pos, child.to)
    }
    if (pos < node.to) out.push({ from: pos, to: node.to, visible: 0 })
  }

  for (const child of children) collectSpans(child, text, out)
}

/**
 * For each character of a block's rendered text, the source offset it came from.
 *
 * The array has one entry per rendered character plus a final entry for the block's end, so
 * `map[n]` is always the source offset a caret sitting before rendered character `n` maps to.
 */
export function visibleMap(block: SourceBlock, text: string): number[] {
  const map: number[] = []

  if (block.contentFrom != null && block.contentTo != null) {
    for (let i = block.contentFrom; i < block.contentTo; i += 1) map.push(i)
    map.push(block.contentTo)
    return map
  }

  // Code keeps its text verbatim, but the fence, the info string and the indent of an
  // indented block are not part of it, and the lines arrive as separate CodeText nodes.
  if (block.node && CODE.has(block.name)) {
    let previous: SourceNode | null = null
    for (let child = block.node.firstChild; child; child = child.nextSibling) {
      if (child.name !== 'CodeText') continue
      if (previous) map.push(previous.to)
      for (let i = child.from; i < child.to; i += 1) map.push(i)
      previous = child
    }
    map.push(previous ? previous.to : block.from)
    return map
  }

  const spans: Span[] = []
  if (block.node) collectSpans(block.node, text, spans)
  spans.sort((a, b) => a.from - b.from || a.to - b.to)

  let index = 0
  let pos = block.from
  while (pos < block.to) {
    let span = spans[index]
    while (span && span.to <= pos) {
      index += 1
      span = spans[index]
    }
    if (span && span.from <= pos) {
      for (let n = 0; n < span.visible; n += 1) map.push(pos)
      pos = Math.max(pos + 1, span.to)
      continue
    }
    map.push(pos)
    pos += 1
  }
  map.push(block.to)
  return map
}

export function sourceOffsetAt(map: number[], textOffset: number): number {
  return map[Math.max(0, Math.min(textOffset, map.length - 1))] ?? 0
}

export function textOffsetAt(map: number[], sourceOffset: number): number {
  // `map` is non-decreasing, so this finds the last entry at or before the offset.
  let low = 0
  let high = map.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((map[mid] ?? 0) <= sourceOffset) low = mid
    else high = mid - 1
  }
  /*
   * Landing exactly on a rendered character means the caret was on it. Landing past one
   * means the caret sits inside markup that character precedes — a link's destination, a
   * fence's info string — and the nearest thing that exists on the other side is the
   * position after it, not before it.
   */
  return (map[low] ?? 0) === sourceOffset ? low : Math.min(low + 1, map.length - 1)
}

/*
 * CodeMirror drops carriage returns when it builds a document out of a string, so a file
 * written with CRLF endings leaves ProseMirror holding text one character per line longer
 * than the source view's. Not counting them keeps both sides on the same scale.
 */
function renderedLength(text: string): number {
  let length = text.length
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 13) length -= 1
  return length
}

export function renderedTextOffset(block: ProseNode, innerOffset: number): number {
  const clamped = Math.max(0, Math.min(innerOffset, block.content.size))
  return renderedLength(block.textBetween(0, clamped))
}

export function renderedInnerOffset(block: ProseNode, textOffset: number): number {
  /*
   * Text length is non-decreasing in the position, so binary search for the first position
   * holding more text than was asked for — the one before it is the last position at the
   * offset. Several positions can share an offset wherever structure carries no text, and
   * taking the last of them is what puts the caret at the start of the text that follows
   * rather than at the end of the text before it: between two table cells, say, or between
   * two list items.
   */
  let low = 0
  let high = block.content.size + 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (renderedLength(block.textBetween(0, mid)) <= textOffset) low = mid + 1
    else high = mid
  }
  return Math.max(0, low - 1)
}

const LOOKAHEAD = 3

/**
 * Pair rendered blocks with source blocks, returning the source index for each rendered one.
 *
 * Walking the two sequences in lockstep rather than trusting a bare index means a construct
 * only one side models — a link reference definition, which the rendered document drops
 * entirely, or a math block, which the source parser reads as a paragraph — costs at most
 * its own block instead of shifting every block that follows it.
 */
export function alignBlocks(
  renderedKinds: readonly string[],
  sourceKinds: readonly string[]
): Array<number | null> {
  const pairs: Array<number | null> = new Array(renderedKinds.length).fill(null)
  let rendered = 0
  let source = 0

  while (rendered < renderedKinds.length && source < sourceKinds.length) {
    const renderedKind = renderedKinds[rendered]
    const sourceKindHere = sourceKinds[source]
    if (renderedKind === undefined || sourceKindHere === undefined) break

    if (renderedKind === sourceKindHere) {
      pairs[rendered] = source
      rendered += 1
      source += 1
      continue
    }

    const skipSource = sourceKinds.slice(source + 1, source + 1 + LOOKAHEAD).indexOf(renderedKind)
    const skipRendered = renderedKinds
      .slice(rendered + 1, rendered + 1 + LOOKAHEAD)
      .indexOf(sourceKindHere)

    if (skipSource >= 0 && (skipRendered < 0 || skipSource <= skipRendered)) {
      source += 1
      continue
    }
    if (skipRendered >= 0) {
      rendered += 1
      continue
    }

    // Neither side recognises the other nearby: pair them anyway rather than desynchronise.
    pairs[rendered] = source
    rendered += 1
    source += 1
  }

  return pairs
}
