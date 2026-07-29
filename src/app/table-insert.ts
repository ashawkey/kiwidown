import { Table } from 'lucide'

import { iconButton } from './icon'

export interface TableSize {
  rows: number
  columns: number
}

/** A Liquid Glass dialog for choosing the dimensions of a Markdown table. */
export function createTableInsert(onInsert: (size: TableSize) => void): {
  button: HTMLButtonElement
  dialog: HTMLDialogElement
} {
  const dialog = document.createElement('dialog')
  dialog.className = 'app-table-dialog'
  dialog.setAttribute('aria-labelledby', 'app-table-dialog-title')

  const form = document.createElement('form')
  form.method = 'dialog'
  form.className = 'app-table-dialog__form'

  const title = document.createElement('h2')
  title.id = 'app-table-dialog-title'
  title.textContent = 'Insert table'

  const hint = document.createElement('p')
  hint.className = 'app-table-dialog__hint'
  hint.textContent = 'Choose the table height and width. Rows include the header row.'

  function dimension(name: string, labelText: string, value: string, min: string): HTMLLabelElement {
    const label = document.createElement('label')
    label.className = 'app-table-dialog__dimension'

    const text = document.createElement('span')
    text.textContent = labelText

    const input = document.createElement('input')
    input.name = name
    input.type = 'number'
    input.value = value
    input.min = min
    input.step = '1'
    input.required = true
    input.inputMode = 'numeric'

    label.append(text, input)
    return label
  }

  const dimensions = document.createElement('div')
  dimensions.className = 'app-table-dialog__dimensions'
  const rows = dimension('rows', 'Rows', '3', '2')
  const times = document.createElement('span')
  times.className = 'app-table-dialog__times'
  times.textContent = '×'
  times.setAttribute('aria-hidden', 'true')
  const columns = dimension('columns', 'Columns', '3', '1')
  dimensions.append(rows, times, columns)

  const actions = document.createElement('div')
  actions.className = 'app-table-dialog__actions'

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'app-button'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => dialog.close())

  const insert = document.createElement('button')
  insert.type = 'submit'
  insert.className = 'app-button is-primary'
  insert.textContent = 'Insert'
  actions.append(cancel, insert)

  form.append(title, hint, dimensions, actions)
  dialog.appendChild(form)

  const rowInput = rows.querySelector('input') as HTMLInputElement
  const columnInput = columns.querySelector('input') as HTMLInputElement

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!form.reportValidity()) return
    const size = {
      rows: rowInput.valueAsNumber,
      columns: columnInput.valueAsNumber,
    }
    dialog.close()
    onInsert(size)
  })

  const button = iconButton(Table, 'Insert table', () => {
    dialog.showModal()
    rowInput.select()
  })

  return { button, dialog }
}
