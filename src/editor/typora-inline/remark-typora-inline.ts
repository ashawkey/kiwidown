import type { Root, RootContent, PhrasingContent, Text } from 'mdast'
import type { Plugin, Processor } from 'unified'

/*
 * Typora's inline extensions: ==highlight==, X^2^ superscript, H~2~O subscript.
 *
 * None of these are CommonMark or GFM, and each would normally need a micromark syntax
 * extension — a substantial amount of code per marker. Instead this rewrites the parsed
 * tree: remark has already separated code spans, links, HTML and the like into their own
 * node types, so splitting plain `text` nodes on these delimiters can't corrupt anything
 * that merely looks like one. `~` is available for subscript only because the editor
 * disables remark-gfm's single-tilde strikethrough (see src/editor/index.ts).
 *
 * The same plugin registers the serialisers, so the syntax survives a round-trip.
 */

interface Marker {
  /** mdast node type produced. */
  type: 'highlight' | 'superscript' | 'subscript'
  delimiter: string
  pattern: RegExp
}

const MARKERS: readonly Marker[] = [
  // Doubled delimiter: content may contain single `=` but not `==`.
  { type: 'highlight', delimiter: '==', pattern: /==(?!\s)((?:[^=]|=(?!=))+?)(?<!\s)==/g },
  // Single delimiters, and Typora treats whitespace as terminating them — `2^10` stays
  // literal, `X^2^` does not.
  { type: 'superscript', delimiter: '^', pattern: /\^(?!\s)([^\s^]+?)\^/g },
  { type: 'subscript', delimiter: '~', pattern: /~(?!\s)([^\s~]+?)~/g },
]

interface CustomNode {
  type: Marker['type']
  children: PhrasingContent[]
}

/** Split one text node on `marker`, leaving unmatched text as-is. */
function splitText(node: Text, marker: Marker): PhrasingContent[] {
  const out: PhrasingContent[] = []
  let last = 0
  marker.pattern.lastIndex = 0

  for (let m = marker.pattern.exec(node.value); m; m = marker.pattern.exec(node.value)) {
    const inner = m[1]
    if (inner === undefined) continue
    if (m.index > last) out.push({ type: 'text', value: node.value.slice(last, m.index) })
    out.push({ type: marker.type, children: [{ type: 'text', value: inner }] } as unknown as PhrasingContent)
    last = m.index + m[0].length
  }

  if (out.length === 0) return [node]
  if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) })
  return out
}

function transform(node: RootContent | Root): void {
  const parent = node as { children?: RootContent[] }
  if (!Array.isArray(parent.children)) return

  // Applied in order, each pass working on whatever text the previous one left behind, so
  // `==H~2~O==` nests correctly.
  for (const marker of MARKERS) {
    const next: RootContent[] = []
    for (const child of parent.children) {
      if (child.type === 'text') next.push(...(splitText(child, marker) as RootContent[]))
      else next.push(child)
    }
    parent.children = next
  }

  for (const child of parent.children) transform(child)
}

/** Serialiser for one marker type — wraps the phrasing content in its delimiters. */
function handler(marker: Marker) {
  return (node: CustomNode, _parent: unknown, state: { containerPhrasing: Function }, info: unknown) => {
    const value = state.containerPhrasing(node, {
      ...(info as object),
      before: marker.delimiter,
      after: marker.delimiter,
    })
    return `${marker.delimiter}${value}${marker.delimiter}`
  }
}

export const remarkTyporaInline: Plugin<[], Root> = function remarkTyporaInline(this: Processor) {
  const data = this.data() as {
    toMarkdownExtensions?: unknown[]
  }
  const handlers: Record<string, unknown> = {}
  for (const marker of MARKERS) handlers[marker.type] = handler(marker)

  // `unsafe` is deliberately left empty. Declaring `^`/`~`/`=` unsafe would make
  // remark escape every literal one in the document, so `2^10` would come back as
  // `2\^10` — mangling text the user never marked up.
  const extensions = (data.toMarkdownExtensions ??= [])
  extensions.push({ handlers })

  return (tree: Root) => {
    transform(tree)
  }
}
