import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import type { Node } from '@milkdown/kit/prose/model'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

/*
 * The half of the DOM contract that node attribute slices can't reach.
 *
 * Two constructs need markup Milkdown's schemas don't produce:
 *
 *  - Task list items. GFM's schema override replaces list_item's toDOM outright when
 *    `checked` is set, so it never consults `listItemAttr`, and it emits no checkbox —
 *    just `<li data-checked>`. Typora needs `<li class="task-list-item md-task-list-item
 *    task-list-done"><input type="checkbox" checked>`.
 *  - Footnote references, whose schema has no attribute slice at all.
 *
 * Both are done with decorations rather than by forking the schemas. `extendSchema` is
 * not usable here: it re-wraps the *original* schema factory, so calling it on
 * `listItemSchema` would silently discard GFM's task-list extension. Node decorations
 * layer classes onto whatever the schemas produce and keep working across upstream
 * changes to them.
 */

const key = new PluginKey('TYPORA_NODES')

/** Node names carrying Typora classes that the attribute slices can't set. */
const TASK_ITEM = 'list_item'
const FOOTNOTE_REF = 'footnote_reference'

function checkboxWidget(pos: number, checked: boolean): Decoration {
  /*
   * Placed at `pos + 1` — the first position inside the list item, before its paragraph —
   * so it renders as a direct child of the <li>. That matters: base.css positions the
   * box with `.md-task-list-item > input`, a direct-child selector, and themes draw their
   * own art from `li.md-task-list-item.task-list-done::before`.
   *
   * It has to be a widget rather than part of toDOM because ProseMirror requires the
   * content hole to be a node's only child, so `['li', attrs, ['input'], 0]` is rejected.
   */
  return Decoration.widget(
    pos + 1,
    (view: EditorView, getPos: () => number | undefined) => {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = checked
      input.addEventListener('mousedown', (event) => event.preventDefault())
      input.addEventListener('click', (event) => {
        event.preventDefault()
        const at = getPos()
        if (at == null) return
        // getPos() reports the widget's own position; the list item opens one before it.
        view.dispatch(view.state.tr.setNodeAttribute(at - 1, 'checked', !checked))
      })
      return input
    },
    {
      side: -1,
      // Re-render only when the checked state actually changes; identical keys let
      // ProseMirror reuse the existing DOM across unrelated edits.
      key: `task-checkbox-${checked}`,
      stopEvent: () => true,
      ignoreSelection: true,
    }
  )
}

function build(doc: Node): DecorationSet {
  const decorations: Decoration[] = []

  doc.descendants((node, pos) => {
    if (node.type.name === TASK_ITEM && node.attrs['checked'] != null) {
      const checked = node.attrs['checked'] === true
      decorations.push(
        // Both class names on purpose: base.css keys the layout off md-task-list-item, and
        // most themes follow it, but some still reach for the bare task-list-item.
        Decoration.node(pos, pos + node.nodeSize, {
          class: `task-list-item md-task-list-item ${checked ? 'task-list-done' : 'task-list-not-done'}`,
        }),
        checkboxWidget(pos, checked)
      )
      return true
    }

    if (node.type.name === FOOTNOTE_REF) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'md-footnote' }))
      return false
    }

    return true
  })

  return DecorationSet.create(doc, decorations)
}

/** Adds the Typora classes and task-list checkboxes that schemas can't express. */
export const typoraNodes = $prose(
  () =>
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state: EditorState) => build(state.doc),
        // Cheap to recompute, but only worth doing when the document actually changed —
        // plain cursor movement leaves every one of these decorations identical.
        apply: (tr, value) => (tr.docChanged ? build(tr.doc) : value.map(tr.mapping, tr.doc)),
      },
      props: {
        decorations(state) {
          return key.getState(state)
        },
      },
    })
)
