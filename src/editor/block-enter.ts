import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'
import type { Attrs, NodeType } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'

/*
 * Enter, on a line that has named a block, opens that block.
 *
 * Typing ```` ```bash ```` or `$$` and pressing Enter is how you open a fence or a formula
 * in Typora, and it is what everyone tries first. Milkdown ships input rules for the same
 * syntax, but an input rule can only fire on *typed text* — so they trigger on the space
 * after the marker and Enter does nothing but split the paragraph, leaving the marker
 * behind as literal text.
 *
 * Ordering is why this is a plugin prop rather than a keymap entry: Milkdown builds one
 * keymap plugin and appends it *after* every $prose plugin, so a keymap of ours could
 * never outrank the base Enter binding (splitBlock), whereas handleKeyDown here is
 * consulted first. Node types are read off the schema rather than captured from the ctx,
 * which keeps this independent of the order the plugins were registered in.
 */

interface Opener {
  /** Matched against the whole line, which must be nothing but the marker. */
  match: RegExp
  node: string
  attrs?: (match: RegExpExecArray) => Attrs
}

const OPENERS: readonly Opener[] = [
  // Language names in the wild include `c++`, `objective-c`, `f#` and `.net`.
  {
    match: /^```([\w+#.-]*)$/,
    node: 'code_block',
    attrs: (match) => ({ language: (match[1] ?? '').toLowerCase() }),
  },
  { match: /^\$\$$/, node: 'math_block' },
]

function open(view: EditorView, type: NodeType, attrs: Attrs | undefined): boolean {
  const { state } = view
  const { $from } = state.selection
  // The paragraph is being replaced wholesale, so its parent has to accept the new block
  // in its place — inside a table cell or a tight list item, it may not.
  if (!$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), type)) return false

  const from = $from.before()
  const to = $from.after()
  const tr = state.tr.replaceWith(from, to, type.create(attrs))
  // One position in: the new block is empty, so this is its only inside position.
  tr.setSelection(TextSelection.create(tr.doc, from + 1))
  view.dispatch(tr.scrollIntoView())
  return true
}

/** Turns a ```` ``` ````/`$$` line into the block it names when Enter is pressed. */
export const blockEnter = $prose(
  () =>
    new Plugin({
      key: new PluginKey('TYPORA_BLOCK_ENTER'),
      props: {
        handleKeyDown: (view, event) => {
          if (event.key !== 'Enter') return false
          if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false

          const { $from, empty } = view.state.selection
          if (!empty) return false

          const parent = $from.parent
          // Already inside a fence or a formula: there the marker is content, not syntax.
          if (!parent.isTextblock || parent.type.spec.code) return false
          // Only at the end of the line, so Enter in the middle of text still splits it.
          if ($from.parentOffset !== parent.content.size) return false

          for (const opener of OPENERS) {
            const match = opener.match.exec(parent.textContent)
            if (!match) continue
            const type = view.state.schema.nodes[opener.node]
            if (!type) continue
            return open(view, type, opener.attrs?.(match))
          }

          return false
        },
      },
    })
)
