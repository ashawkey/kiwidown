import { applyTheme, getThemes, type ThemeEntry } from '../theme'

/**
 * Theme picker, grouped by upstream pack, plus the attribution line the vendored
 * themes' licences require us to carry.
 */
export function createThemePicker(onChange?: (theme: ThemeEntry) => void): {
  element: HTMLElement
  select: (id: string) => Promise<void>
} {
  const wrap = document.createElement('div')
  wrap.className = 'app-theme-picker'

  const label = document.createElement('label')
  label.id = 'theme-select-label'
  label.htmlFor = 'theme-select'
  label.textContent = 'Theme'

  const control = document.createElement('div')
  control.className = 'app-theme-control'

  const trigger = document.createElement('button')
  trigger.id = 'theme-select'
  trigger.className = 'app-theme-trigger'
  trigger.type = 'button'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-labelledby', `${label.id} theme-select-value`)

  const value = document.createElement('span')
  value.id = 'theme-select-value'
  value.className = 'app-theme-trigger__value'

  const chevron = document.createElement('span')
  chevron.className = 'app-theme-trigger__chevron'
  chevron.setAttribute('aria-hidden', 'true')
  trigger.append(value, chevron)

  const menu = document.createElement('div')
  menu.id = 'theme-select-menu'
  menu.className = 'app-theme-menu'
  menu.setAttribute('role', 'listbox')
  menu.setAttribute('aria-labelledby', label.id)
  menu.hidden = true
  trigger.setAttribute('aria-controls', menu.id)

  const byPack = new Map<string, ThemeEntry[]>()
  for (const theme of getThemes()) {
    const list = byPack.get(theme.pack)
    if (list) list.push(theme)
    else byPack.set(theme.pack, [theme])
  }

  const optionButtons = new Map<string, HTMLButtonElement>()
  let groupIndex = 0
  for (const [pack, entries] of byPack) {
    const group = document.createElement('div')
    group.className = 'app-theme-menu__group'
    group.setAttribute('role', 'group')

    const heading = document.createElement('div')
    heading.id = `theme-pack-${groupIndex++}`
    heading.className = 'app-theme-menu__heading'
    heading.textContent = pack
    group.setAttribute('aria-labelledby', heading.id)
    group.appendChild(heading)

    for (const theme of entries) {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = 'app-theme-option'
      option.dataset['themeId'] = theme.id
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', 'false')
      option.tabIndex = -1
      option.textContent = theme.dark ? `${theme.name} · dark` : theme.name
      option.addEventListener('click', () => {
        closeMenu(true)
        void select_(theme.id)
      })
      optionButtons.set(theme.id, option)
      group.appendChild(option)
    }
    menu.appendChild(group)
  }

  const credit = document.createElement('span')
  credit.className = 'app-credit'

  function activeOption(): HTMLButtonElement | undefined {
    return optionButtons.get(trigger.dataset['themeId'] ?? '')
  }

  function openMenu(focusOption: 'selected' | 'first' | 'last' | false = false): void {
    if (!menu.hidden) return
    menu.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    if (focusOption) {
      const options = [...optionButtons.values()]
      const option =
        focusOption === 'first'
          ? options[0]
          : focusOption === 'last'
            ? options[options.length - 1]
            : activeOption()
      option?.focus()
      option?.scrollIntoView({ block: 'nearest' })
    } else {
      activeOption()?.scrollIntoView({ block: 'nearest' })
    }
  }

  function closeMenu(restoreFocus = false): void {
    if (menu.hidden) return
    menu.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    if (restoreFocus) trigger.focus()
  }

  async function select_(id: string): Promise<void> {
    const theme = await applyTheme(id)
    trigger.dataset['themeId'] = theme.id
    value.textContent = theme.dark ? `${theme.name} · dark` : theme.name
    for (const [optionId, option] of optionButtons) {
      option.setAttribute('aria-selected', String(optionId === theme.id))
    }

    credit.replaceChildren()
    const link = document.createElement('a')
    link.href = theme.source
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = theme.pack
    credit.append(`${theme.author}/`, link, ` · ${theme.license}`)

    onChange?.(theme)
  }

  trigger.addEventListener('click', (event) => {
    if (menu.hidden) openMenu(event.detail === 0 ? 'selected' : false)
    else closeMenu()
  })

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(event.key === 'ArrowDown' ? 'selected' : 'last')
    } else if (event.key === 'Escape') {
      closeMenu()
    }
  })

  menu.addEventListener('keydown', (event) => {
    const options = [...optionButtons.values()]
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    let next = current
    if (event.key === 'ArrowDown') next = Math.min(current + 1, options.length - 1)
    else if (event.key === 'ArrowUp') next = Math.max(current - 1, 0)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    else if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu(true)
      return
    } else return

    event.preventDefault()
    options[next]?.focus()
    options[next]?.scrollIntoView({ block: 'nearest' })
  })

  document.addEventListener('pointerdown', (event) => {
    if (!control.contains(event.target as Node)) closeMenu()
  })
  document.addEventListener('focusin', (event) => {
    if (!control.contains(event.target as Node)) closeMenu()
  })

  control.append(trigger, menu)
  wrap.append(label, control, credit)
  return { element: wrap, select: select_ }
}
