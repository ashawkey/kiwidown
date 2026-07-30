import { closeHistory } from '@milkdown/kit/prose/history'
import { Selection } from '@milkdown/kit/prose/state'
import type { Node } from '@milkdown/kit/prose/model'
import type { Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

/*
 * The document edits behind the table toolbar.
 *
 * Every one of them works from a table's *position* rather than from the selection,
 * because the toolbar acts on the table the pointer is over — routinely not the one the
 * caret is in, and often with the caret nowhere near a table at all. That rules out GFM's
 * own table commands (`addRowAfterCommand`, `setAlignCommand`, `deleteSelectedCellsCommand`
 * and friends): each of them resolves `selectedRect(state)` first, so it would edit
 * whichever table the caret happens to be in, or refuse to run when it is in none.
 */

const TABLE = 'table'

export type Alignment = 'left' | 'center' | 'right'

const ALIGNMENTS: readonly string[] = ['left', 'center', 'right']

export interface TableTarget {
  /** Position of the table node itself, so `pos + node.nodeSize` is where it ends. */
  pos: number
  node: Node
}

export interface TableSize {
  /** Including the header row, matching how the insert-table dialog counts. */
  rows: number
  columns: number
}

/** A GFM table is a header row plus at least one body row; row 0 is always the header. */
export const MIN_ROWS = 2
export const MIN_COLUMNS = 1

/*
 * Each of these is one undo.
 *
 * prosemirror-history merges transactions that arrive within half a second of each other,
 * which is right for typing and wrong for a button: aligning a column a moment after typing
 * in it would leave one Ctrl+Z that undoes both, and no way to take back just the
 * alignment. closeHistory ends the previous group so the command starts its own.
 */
function commit(view: EditorView, tr: Transaction): void {
  view.dispatch(closeHistory(tr))
}

/** The table containing `dom`, or null if it isn't inside one. */
export function tableAt(view: EditorView, dom: globalThis.Node | null): TableTarget | null {
  if (!dom || !view.dom.contains(dom)) return null

  let pos: number
  try {
    pos = view.posAtDOM(dom, 0)
  } catch {
    // The element is in the editor but not in the current document — a node view's own
    // chrome, or DOM that a transaction has already replaced.
    return null
  }

  const $pos = view.state.doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth)
    if (node.type.name === TABLE) return { pos: $pos.before(depth), node }
  }
  return null
}

export function sizeOf(node: Node): TableSize {
  return { rows: node.childCount, columns: node.firstChild?.childCount ?? 0 }
}

/**
 * A column's alignment, read from its header cell.
 *
 * The header is the authority because that is what serialises: the `:---:` row is written
 * from the first row's cells, and GFM has no way to align a single body cell differently.
 */
export function alignmentOf(node: Node, column: number): Alignment {
  const header = node.firstChild
  const cell = header && column < header.childCount ? header.child(column) : undefined
  const value = cell?.attrs['alignment']
  return typeof value === 'string' && ALIGNMENTS.includes(value) ? (value as Alignment) : 'left'
}

/** Position of the cell at `row`/`column` within the table at `target.pos`. */
function cellPos(target: TableTarget, row: Node, rowOffset: number, column: number): number {
  let offset = 0
  for (let i = 0; i < column; i++) offset += row.child(i).nodeSize
  // pos + 1 enters the table, rowOffset reaches the row, + 1 enters it.
  return target.pos + 1 + rowOffset + 1 + offset
}

/**
 * Align a whole column.
 *
 * Every cell is set, not just the header. GFM's `keepTableAlignPlugin` would copy the
 * header's value down on the next transaction anyway, but doing it here keeps the change
 * atomic — one step, one undo, and no frame where the body still shows the old alignment.
 */
export function alignColumn(
  view: EditorView,
  target: TableTarget,
  column: number,
  alignment: Alignment
): boolean {
  const tr = view.state.tr

  target.node.forEach((row, rowOffset) => {
    if (column >= row.childCount) return
    const cell = row.child(column)
    if (cell.attrs['alignment'] === alignment) return
    tr.setNodeMarkup(cellPos(target, row, rowOffset, column), undefined, {
      ...cell.attrs,
      alignment,
    })
  })

  if (!tr.docChanged) return false
  commit(view, tr)
  return true
}

/**
 * Resize a table in place, growing or shrinking from the bottom-right.
 *
 * Rebuilt as one replacement rather than as a run of add/delete commands: it is a single
 * step to undo, it can't leave a half-resized table behind if one of the steps fails, and
 * reusing the existing cell nodes means their content, marks and alignment survive
 * verbatim. Cells outside the new bounds are dropped — undo is the way back.
 */
export function resizeTable(view: EditorView, target: TableTarget, size: TableSize): boolean {
  const { state } = view
  const table = state.schema.nodes[TABLE]
  const headerRow = state.schema.nodes['table_header_row']
  const header = state.schema.nodes['table_header']
  const bodyRow = state.schema.nodes['table_row']
  const bodyCell = state.schema.nodes['table_cell']
  if (!table || !headerRow || !header || !bodyRow || !bodyCell) return false

  const rows = Math.max(MIN_ROWS, Math.round(size.rows))
  const columns = Math.max(MIN_COLUMNS, Math.round(size.columns))
  const current = sizeOf(target.node)
  if (rows === current.rows && columns === current.columns) return false

  // New columns inherit nothing to align to, so they take the schema default.
  const alignments = Array.from({ length: columns }, (_, column) =>
    column < current.columns ? alignmentOf(target.node, column) : 'left'
  )

  const built: Node[] = []
  for (let row = 0; row < rows; row++) {
    const source = row < target.node.childCount ? target.node.child(row) : undefined
    const cellType = row === 0 ? header : bodyCell
    const cells: Node[] = []

    for (let column = 0; column < columns; column++) {
      const existing = source && column < source.childCount ? source.child(column) : undefined
      const attrs = { ...(existing?.attrs ?? {}), alignment: alignments[column] }
      const cell = existing
        ? cellType.create(attrs, existing.content, existing.marks)
        : cellType.createAndFill(attrs)
      if (!cell) return false
      cells.push(cell)
    }

    built.push((row === 0 ? headerRow : bodyRow).create(source?.attrs, cells))
  }

  const from = target.pos
  const to = target.pos + target.node.nodeSize
  // Whether the caret has to be rehomed: mapping a position through a wholesale
  // replacement lands it at an edge of the new table rather than in a cell.
  const disturbed = state.selection.from < to && state.selection.to > from

  const tr = state.tr.replaceWith(from, to, table.create(target.node.attrs, built))
  // from + 3 is inside the first header cell: + 1 enters the table, + 1 the header row,
  // + 1 the cell.
  if (disturbed) tr.setSelection(Selection.near(tr.doc.resolve(from + 3)))
  commit(view, tr)
  return true
}

/** Delete a table, leaving a document that still has somewhere to put the caret. */
export function removeTable(view: EditorView, target: TableTarget): void {
  const { state } = view
  const tr = state.tr.delete(target.pos, target.pos + target.node.nodeSize)

  // The trailing plugin keeps a paragraph after a final table, so in practice something
  // always survives — but a document with no block at all has nowhere for the caret to go,
  // and that is not a state to discover from a crash.
  if (tr.doc.childCount === 0) {
    const paragraph = state.schema.nodes['paragraph']?.createAndFill()
    if (paragraph) tr.insert(0, paragraph)
  }

  commit(view, tr)
  view.focus()
}
