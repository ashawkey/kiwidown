import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'

/*
 * Typora marks the block the caret is in with `.md-focus`, and every block wrapping it
 * with `.md-focus-container`. Themes lean on it heavily — from subtle left-margin markers
 * to the heading bullets in `#write > h3.md-focus:before` — so without it they look inert
 * while editing.
 *
 * It is also what ./md-meta.ts and src/theme/bridge.css hang reveal-on-focus off: the
 * syntax markers, a formula's TeX source and a diagram's source are all shown by the same
 * `.md-focus` the themes are reading.
 */

interface FocusState {
  decorations: DecorationSet
  /** Typora only marks focus while the editor actually has it. */
  focused: boolean
}

const key = new PluginKey<FocusState>('TYPORA_MD_FOCUS')

function build(state: EditorState, focused: boolean): DecorationSet {
  if (!focused) return DecorationSet.empty

  const { $anchor, $head, empty } = state.selection
  // Keep the block focused while selecting within it. Dropping `.md-focus` on the first
  // mouse movement hides math and diagram source mid-drag, which collapses the browser's
  // selection. A range spanning blocks still has no single focused block.
  if (!empty && !$anchor.sameParent($head)) return DecorationSet.empty

  const decorations: Decoration[] = []
  for (let depth = $head.depth; depth > 0; depth--) {
    const node = $head.node(depth)
    const pos = $head.before(depth)
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: depth === $head.depth ? 'md-focus' : 'md-focus-container',
      })
    )
  }
  return DecorationSet.create(state.doc, decorations)
}

/** Marks the block containing the caret with `.md-focus`, its ancestors with `.md-focus-container`. */
export const mdFocus = $prose(
  () =>
    new Plugin<FocusState>({
      key,
      state: {
        init: (_, state) => ({ decorations: build(state, false), focused: false }),
        apply: (tr: Transaction, prev, _old, state) => {
          const flag = tr.getMeta(key) as boolean | undefined
          const focused = flag ?? prev.focused
          // Selection changes are the whole point here, so unlike ./typora-nodes.ts this
          // has to recompute whenever the selection moves, not just on doc changes.
          if (flag === undefined && !tr.docChanged && !tr.selectionSet) return prev
          return { decorations: build(state, focused), focused }
        },
      },
      props: {
        decorations(state) {
          return key.getState(state)?.decorations
        },
        handleDOMEvents: {
          // EditorState knows nothing about focus, so feed it in as transaction metadata.
          focus: (view) => {
            view.dispatch(view.state.tr.setMeta(key, true))
            return false
          },
          blur: (view) => {
            view.dispatch(view.state.tr.setMeta(key, false))
            return false
          },
        },
      },
    })
)
