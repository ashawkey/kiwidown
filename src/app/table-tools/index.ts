import { AlignCenter, AlignLeft, AlignRight, Grid2x2, Trash2 } from 'lucide'

import { iconButton, type IconNode } from '../icon'
import {
  alignColumn,
  alignmentOf,
  removeTable,
  resizeTable,
  sizeOf,
  tableAt,
  type Alignment,
  type TableTarget,
} from './operations'
import { createSizeGrid } from './size-grid'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

/*
 * The toolbar that appears above a table on hover.
 *
 * A WYSIWYG table has the same problem as a code fence: the syntax that shaped it — the
 * `|---|:-:|` line — is consumed when the block is created, so its column count and its
 * alignment have no visible handle left. ../table-insert.ts can only answer this at the
 * moment a table is created; everything after that needs somewhere to grab.
 *
 * Three things live in it: the size, the alignment of one column, and deleting the table.
 * Between them they cover every part of a GFM table that isn't cell text.
 *
 * ## Why it sits outside #write
 *
 * The toolbar is absolutely positioned inside Typora's <content> scroller, as a sibling of
 * the editor rather than a child of it. Two reasons, both hard:
 *
 *  - doc/dom-contract.md requires #write to be the direct parent of block content, and
 *    themes lean on that with `#write > *` selectors. A wrapper around the table, or a
 *    widget decoration beside it, would put an element in that sequence which Typora never
 *    emits.
 *  - Themes are entitled to make a table a clipping box — glassy.css sets `overflow:
 *    hidden` on it so cell borders can't paint over the pane's rounded corners — and
 *    anything drawn *above* a table from inside it would be clipped away entirely.
 *
 * Being a child of the scroller (rather than of the stage) is what makes it scroll with
 * the document without a scroll listener: absolutely positioned children of a scroll
 * container move with its content.
 *
 * ## The space it occupies
 *
 * Chrome that appears on hover must not reflow the document, or a table half a page long
 * would jump under the pointer as it arrives. So the room for it is reserved permanently,
 * as extra top margin on tables — `--app-table-tools-space`, which the built-in themes add
 * to their own table margin. Themes that don't know the variable still get the toolbar;
 * it simply overlaps whatever is above the table instead of sitting in a gap of its own.
 *
 * That margin is part of the table as far as pointing is concerned: hovering it opens the
 * toolbar, and the column it is over is the column the toolbar aims at.
 *
 * ## Why the align buttons travel
 *
 * The target column is whichever one the pointer is over horizontally, and it keeps up as
 * the pointer moves — which means the route to the button matters. With the align buttons
 * parked at one end, reaching them is a diagonal sweep across the table, and the column the
 * pointer leaves over is the last one it crossed, not the one it started on. A wide first
 * column swallows most of that sweep, so nearly every alignment landed on column 1.
 *
 * Two things answer that. The align group rides above the column it acts on, so the trip
 * from a cell to its own buttons is a short one straight up, and the group is its own
 * answer to which column is meant. And re-aiming asks for the pointer to settle: crossing
 * a column on the way somewhere is not pointing at it. The second is what actually makes
 * this correct — the group cannot always sit exactly over its column, since it has to keep
 * clear of the buttons at either end — but the first is what makes it legible.
 */

/** Room to reserve before the toolbar has been measured; see `band`. */
const BAND = 36
/** Clearance the align group keeps from the buttons at either end of the strip. */
const CLEARANCE = 8
/**
 * How long the pointer has to settle on a new column before the toolbar re-aims at it.
 *
 * A hand crossing a table to reach a button passes over a column in a few tens of
 * milliseconds and means none of them; pointing at one means coming to rest on it. Long
 * enough to cover a sweep, short enough that deliberately choosing a column feels immediate.
 */
const DWELL = 140

export interface TableToolsOptions {
  /** Typora's <content> scroller: the toolbar's offset parent, and where hover is watched. */
  scroller: HTMLElement
  view: () => EditorView | undefined
}

export function bindTableTools(options: TableToolsOptions): () => void {
  const { scroller } = options

  /** The table the toolbar is attached to, identified by its DOM rather than a position:
      a position would have to be mapped through every transaction, whereas the element is
      either still in the document or gone. */
  let table: HTMLTableElement | null = null
  /** The column the align buttons act on — the last one the pointer was over. */
  let column = 0
  /** Where the table was when the toolbar was last positioned, and the state the buttons
      were last read from: both are how {@link follow} decides it has nothing to do. */
  let placed: { left: number; top: number; width: number } | undefined
  let synced: EditorState | undefined
  let frame = 0
  /** How far above a table the toolbar reaches, and so how deep the band of margin is that
      counts as pointing at it. Measured from the strip once it has been placed, because the
      height is the icons' business and the gap the stylesheet's. */
  let band = BAND
  /** A column the pointer has entered but not yet settled on. */
  let aiming: { at: number; timer: number } | undefined

  const element = document.createElement('div')
  element.className = 'app-table-tools'
  element.hidden = true

  const sizer = createSizeGrid(() => {
    sizer.close()
    options.view()?.focus()
  })

  function target(): { view: EditorView; target: TableTarget } | null {
    const view = options.view()
    if (!view || !table) return null
    const found = tableAt(view, table)
    return found ? { view, target: found } : null
  }

  const shape = iconButton(Grid2x2, 'Table size', () => {
    if (sizer.isOpen()) {
      sizer.close()
      return
    }
    const found = target()
    if (!found) return
    sizer.open(sizeOf(found.target.node), (size) => {
      const current = target()
      sizer.close()
      if (!current) return
      resizeTable(current.view, current.target, size)
      current.view.focus()
      // Rebuilding the table replaced its DOM, so the element we were tracking is now
      // detached; pick up the one that took its place before follow() concludes the table
      // is gone and closes the toolbar the pointer is still on.
      const rebuilt = current.view.nodeDOM(current.target.pos)
      table = rebuilt instanceof HTMLTableElement ? rebuilt : null
      if (table) show()
      else hide()
    })
  })

  function aligner(node: IconNode, alignment: Alignment): HTMLButtonElement {
    const button = iconButton(node, `Align column ${alignment}`, () => {
      const found = target()
      if (!found) return
      alignColumn(found.view, found.target, column, alignment)
      sync()
    })
    button.dataset['align'] = alignment
    return button
  }

  const aligners = [aligner(AlignLeft, 'left'), aligner(AlignCenter, 'center'), aligner(AlignRight, 'right')]

  const remove = iconButton(Trash2, 'Delete table', () => {
    const found = target()
    if (!found) return
    removeTable(found.view, found.target)
    hide()
  })

  const start = document.createElement('div')
  start.className = 'app-table-tools__group'
  start.append(shape)

  // Its own capsule because it moves independently of the other two, which stay pinned to
  // the ends of the table.
  const align = document.createElement('div')
  align.className = 'app-table-tools__group app-table-tools__group--align'
  align.append(...aligners)

  const end = document.createElement('div')
  end.className = 'app-table-tools__group'
  end.append(remove)

  /** Names the exact column the align buttons will act on — which is only the same as the
      group's own position while there is room to centre it there. */
  const marker = document.createElement('div')
  marker.className = 'app-table-tools__marker'
  marker.setAttribute('aria-hidden', 'true')

  element.append(start, end, align, marker, sizer.element)
  for (const button of [shape, ...aligners, remove]) button.classList.add('app-table-tools__button')

  /*
   * Toolbar clicks must not disturb the document.
   *
   * preventDefault stops the button taking DOM focus, which would blur the editor and take
   * `.md-focus` — and with it every marker and revealed source the themes hang off it —
   * away for the duration of a click. stopPropagation is for src/editor/click-to-focus.ts,
   * which is listening on the scroller and would otherwise read a click on the toolbar as
   * a click on the margin and move the caret there.
   *
   * The size picker is the deliberate exception: it takes focus explicitly when it opens,
   * because it is a menu and has to answer the arrow keys.
   */
  element.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  /**
   * Where the toolbar has to sit to be over `table`.
   *
   * In the scroller's own coordinates, with the scroll position added: that is what turns a
   * viewport rect into a position on the document, which is what an absolutely positioned
   * child of a scroll container is measured against — and it is also what makes scrolling
   * alone leave this unchanged.
   */
  function geometry(of: HTMLTableElement): { left: number; top: number; width: number } {
    const box = scroller.getBoundingClientRect()
    const rect = of.getBoundingClientRect()
    return {
      left: rect.left - box.left + scroller.scrollLeft,
      top: rect.top - box.top + scroller.scrollTop,
      width: rect.width,
    }
  }

  /** Put the toolbar over `table` and point the marker at the column it is aimed at. */
  function place(): void {
    if (!table) return

    const at = geometry(table)
    placed = at
    element.style.left = `${at.left}px`
    element.style.top = `${at.top}px`
    element.style.width = `${at.width}px`
    // Narrower than its own controls, the strip would stack them; better to overhang a
    // narrow table than to bury the delete button under the align group.
    element.style.minWidth = `${start.offsetWidth + align.offsetWidth + end.offsetWidth + CLEARANCE * 2}px`

    const rect = table.getBoundingClientRect()
    // How far above the table the strip ends up reaching, which is also the depth of margin
    // that counts as pointing at this table.
    const reach = rect.top - element.getBoundingClientRect().top
    if (reach > 0) band = reach

    const cell = table.rows[0]?.cells[column]
    if (cell) {
      const cellRect = cell.getBoundingClientRect()
      const centre = cellRect.left - rect.left + cellRect.width / 2

      // A short centred pill rather than a bar the width of the column: anything spanning
      // the full column sits between two of the table's own rules and reads as a third.
      const width = Math.min(cellRect.width * 0.5, 28)
      marker.style.left = `${centre - width / 2}px`
      marker.style.width = `${width}px`
      marker.hidden = false

      // Over its column, but never over the two buttons that own the ends of the strip.
      const span = align.offsetWidth
      const least = start.offsetWidth + CLEARANCE
      const most = Math.max(least, element.offsetWidth - end.offsetWidth - CLEARANCE - span)
      align.style.left = `${Math.min(most, Math.max(least, centre - span / 2))}px`
      align.hidden = false
    } else {
      marker.hidden = true
      align.hidden = true
    }
  }

  /** Reflect the target column's current alignment on the buttons. */
  function sync(): void {
    const found = target()
    if (!found) return
    synced = found.view.state

    const alignment = alignmentOf(found.target.node, column)
    for (const button of aligners) {
      const own = button.dataset['align']
      const active = own === alignment
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
      const description = `Align column ${column + 1} ${own}`
      button.title = description
      button.setAttribute('aria-label', description)
    }
  }

  function show(): void {
    element.hidden = false
    place()
    sync()
    if (!frame) frame = requestAnimationFrame(follow)
  }

  function hide(): void {
    stopAiming()
    if (element.hidden) return
    sizer.close()
    element.hidden = true
    table = null
    placed = undefined
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  }

  /*
   * Follow the table for as long as the toolbar is up.
   *
   * Everything that moves a table moves it without saying so: an edit above it, an image
   * finishing loading, a diagram drawing itself, the window resizing, a document being
   * swapped in by a tab. Watching for each of those separately means missing one — an
   * earlier attempt observed the editor's height, which doesn't change at all on a
   * document shorter than #write's min-height, so typing above a table left the toolbar
   * behind. Looking each frame costs one rect while a table is hovered and cannot miss.
   *
   * Two comparisons keep it to that. The placement decides whether to move anything — it
   * is in document coordinates, so scrolling does not qualify. EditorState identity, a
   * pointer comparison, decides whether to re-read the document: an edit can change the
   * target column's alignment or its width without moving the table at all.
   */
  function follow(): void {
    frame = 0
    if (element.hidden) return
    if (!table?.isConnected) {
      hide()
      return
    }

    const at = geometry(table)
    const moved =
      !placed || at.left !== placed.left || at.top !== placed.top || at.width !== placed.width
    const edited = options.view()?.state !== synced
    if (moved || edited) place()
    if (edited) sync()

    frame = requestAnimationFrame(follow)
  }

  /**
   * The column at `x`, from the header row's own boxes.
   *
   * Measured rather than read off the cell under the pointer, because the pointer is just
   * as often in the margin above the table, where there is no cell to ask — and a column is
   * a vertical band whether or not there is anything of the table at that height.
   */
  function columnAt(of: HTMLTableElement, x: number): number {
    const cells = of.rows[0]?.cells
    if (!cells?.length) return 0
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index]
      if (cell && x < cell.getBoundingClientRect().right) return index
    }
    return cells.length - 1
  }

  /**
   * The table whose reserved margin the pointer is in, if any.
   *
   * Found by asking what is a toolbar's depth below the pointer: inside that band the
   * answer is the table itself, and everywhere else it isn't. One hit test rather than a
   * pass over every table in the document, which on a long one is the whole difference.
   */
  function tableBelow(event: MouseEvent): HTMLTableElement | null {
    const under = document.elementFromPoint(event.clientX, event.clientY + band)
    const found = (under?.closest('#write table') ?? null) as HTMLTableElement | null
    if (!found) return null
    const rect = found.getBoundingClientRect()
    return event.clientY < rect.top && event.clientY >= rect.top - band ? found : null
  }

  function stopAiming(): void {
    if (aiming) window.clearTimeout(aiming.timer)
    aiming = undefined
  }

  /** Wait for the pointer to settle on `at` before the toolbar re-aims at it. */
  function aimAt(of: HTMLTableElement, at: number): void {
    // Left running rather than restarted, so that resting in a column commits it: the
    // pointer stops sending events the moment it stops moving.
    if (aiming?.at === at) return
    stopAiming()
    aiming = {
      at,
      timer: window.setTimeout(() => {
        aiming = undefined
        if (table !== of || element.hidden) return
        column = at
        show()
      }, DWELL),
    }
  }

  const onMouseMove = (event: MouseEvent) => {
    // While the picker is open the toolbar belongs to it, wherever the pointer goes.
    if (sizer.isOpen()) return

    const from = event.target
    if (!(from instanceof Element)) return

    // On the toolbar's own controls: hold everything still, pending re-aim included. The
    // strip itself takes no pointer events, so this is only the capsules — and a capsule is
    // wider than a narrow column, so a move within one button would otherwise retarget the
    // next one.
    if (element.contains(from)) {
      stopAiming()
      return
    }

    const found = (from.closest('#write table') as HTMLTableElement | null) ?? tableBelow(event)
    if (!found) {
      hide()
      return
    }

    const next = columnAt(found, event.clientX)

    // A table the toolbar is not on yet opens at once, aimed where the pointer already is.
    // Only re-aiming an open one waits, because only that has something to lose.
    if (found !== table || element.hidden) {
      stopAiming()
      table = found
      column = next
      show()
      return
    }

    if (next === column) stopAiming()
    else aimAt(found, next)
  }

  const onMouseLeave = () => {
    if (!sizer.isOpen()) hide()
  }

  // A click anywhere else dismisses the picker, the way a menu does. In the capture phase
  // so it still fires when the click lands on something that stops propagation itself.
  const onDocumentMouseDown = (event: MouseEvent) => {
    if (!sizer.isOpen()) return
    const from = event.target
    if (from instanceof globalThis.Node && element.contains(from)) return
    sizer.close()
    // The open picker was the only thing keeping the toolbar up while the pointer was away
    // from the table. Clicking somewhere else entirely should leave nothing behind.
    if (!(from instanceof Element) || !from.closest('#write table')) hide()
  }

  scroller.addEventListener('mousemove', onMouseMove)
  scroller.addEventListener('mouseleave', onMouseLeave)
  document.addEventListener('mousedown', onDocumentMouseDown, true)

  // Appended last: src/doc/views.ts pins the scroll position by observing
  // `scroller.firstElementChild`, which has to stay the editor.
  scroller.append(element)

  return () => {
    scroller.removeEventListener('mousemove', onMouseMove)
    scroller.removeEventListener('mouseleave', onMouseLeave)
    document.removeEventListener('mousedown', onDocumentMouseDown, true)
    hide()
    element.remove()
  }
}
