import { MIN_COLUMNS, MIN_ROWS, type TableSize } from './operations'

/*
 * The size picker behind the toolbar's grid button.
 *
 * A grid rather than the two number fields the insert dialog uses, for the same reason
 * every editor's table menu is a grid: resizing an existing table is a comparison — "one
 * more column than it has now" — and a grid shows the current shape and the new one in the
 * same picture. The dialog is answering a different question, on an empty document where
 * there is nothing to compare against.
 *
 * The grid is sized from the table it was opened on, so there is always room to grow, and
 * it is capped so a twenty-row table doesn't open a picker taller than the window.
 */

/** Always offer at least this many rows/columns, so a small table can grow in one go. */
const LEAST_SHOWN = 8
/** How far beyond the current size the picker reaches. */
const HEADROOM = 3
const MOST_ROWS = 15
const MOST_COLUMNS = 12

export interface SizeGrid {
  element: HTMLElement
  /** Build for a table of `size` and show; `onPick` receives the chosen size. */
  open: (size: TableSize, onPick: (size: TableSize) => void) => void
  close: () => void
  isOpen: () => boolean
  contains: (node: globalThis.Node | null | undefined) => boolean
}

function clamp(value: number, least: number, most: number): number {
  return Math.max(least, Math.min(most, value))
}

export function createSizeGrid(onDismiss: () => void): SizeGrid {
  const element = document.createElement('div')
  element.className = 'app-table-tools__sizer'
  element.hidden = true
  // Focusable as a whole rather than one tab stop per cell: a 12×15 grid would otherwise
  // put 180 tab stops between the toolbar and everything after it.
  element.tabIndex = 0
  element.setAttribute('role', 'group')
  element.setAttribute('aria-label', 'Table size')

  const grid = document.createElement('div')
  grid.className = 'app-table-tools__grid'

  const label = document.createElement('div')
  label.className = 'app-table-tools__size'
  // The cells are decoration; this line is what a screen reader follows as the value
  // changes under the arrow keys.
  label.setAttribute('aria-live', 'polite')

  element.append(grid, label)

  let cells: HTMLElement[] = []
  let shown: TableSize = { rows: 0, columns: 0 }
  let chosen: TableSize = { rows: 0, columns: 0 }
  let pick: (size: TableSize) => void = () => {}

  function show(rows: number, columns: number): void {
    chosen = {
      rows: clamp(rows, MIN_ROWS, shown.rows),
      columns: clamp(columns, MIN_COLUMNS, shown.columns),
    }
    for (const cell of cells) {
      const inside =
        Number(cell.dataset['row']) <= chosen.rows && Number(cell.dataset['column']) <= chosen.columns
      cell.classList.toggle('is-inside', inside)
    }
    label.textContent = `${chosen.rows} × ${chosen.columns}`
  }

  function cellAt(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element
      ? (target.closest('.app-table-tools__cell') as HTMLElement | null)
      : null
  }

  grid.addEventListener('mousemove', (event) => {
    const cell = cellAt(event.target)
    if (cell) show(Number(cell.dataset['row']), Number(cell.dataset['column']))
  })

  grid.addEventListener('mouseleave', () => show(chosen.rows, chosen.columns))

  grid.addEventListener('click', (event) => {
    const cell = cellAt(event.target)
    if (!cell) return
    show(Number(cell.dataset['row']), Number(cell.dataset['column']))
    pick(chosen)
  })

  element.addEventListener('keydown', (event) => {
    const step: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    const move = step[event.key]
    if (move) {
      event.preventDefault()
      show(chosen.rows + move[0], chosen.columns + move[1])
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(chosen)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onDismiss()
    }
  })

  return {
    element,

    open(size, onPick) {
      pick = onPick
      shown = {
        rows: clamp(size.rows + HEADROOM, LEAST_SHOWN, MOST_ROWS),
        columns: clamp(size.columns + HEADROOM, LEAST_SHOWN, MOST_COLUMNS),
      }

      grid.replaceChildren()
      // Written out here rather than from a custom property: `repeat()` takes an integer,
      // and a var() standing in for one is substituted too late to be parsed as one.
      grid.style.gridTemplateColumns = `repeat(${shown.columns}, var(--app-table-tools-cell))`
      cells = []
      for (let row = 1; row <= shown.rows; row++) {
        for (let column = 1; column <= shown.columns; column++) {
          const cell = document.createElement('div')
          cell.className = 'app-table-tools__cell'
          cell.dataset['row'] = String(row)
          cell.dataset['column'] = String(column)
          cells.push(cell)
        }
      }
      grid.append(...cells)

      // Opens showing the table as it stands, so the first thing the picker says is where
      // you are — and clicking that same cell is a no-op rather than a surprise.
      show(size.rows, size.columns)
      element.hidden = false
      element.focus()
    },

    close() {
      if (element.hidden) return
      element.hidden = true
      grid.replaceChildren()
      cells = []
      pick = () => {}
    },

    isOpen: () => !element.hidden,
    contains: (node) => Boolean(node && element.contains(node)),
  }
}
