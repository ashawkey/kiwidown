import { applyTheme, getThemes, type ThemeEntry } from '../theme'

/**
 * Theme <select>, grouped by upstream pack, plus the attribution line the vendored
 * themes' licences require us to carry.
 */
export function createThemePicker(onChange?: (theme: ThemeEntry) => void): {
  element: HTMLElement
  select: (id: string) => Promise<void>
} {
  const wrap = document.createElement('div')
  wrap.style.display = 'contents'

  const label = document.createElement('label')
  label.htmlFor = 'theme-select'
  label.textContent = 'Theme'

  const select = document.createElement('select')
  select.id = 'theme-select'

  const byPack = new Map<string, ThemeEntry[]>()
  for (const theme of getThemes()) {
    const list = byPack.get(theme.pack)
    if (list) list.push(theme)
    else byPack.set(theme.pack, [theme])
  }
  for (const [pack, entries] of byPack) {
    const group = document.createElement('optgroup')
    group.label = pack
    for (const theme of entries) {
      const option = document.createElement('option')
      option.value = theme.id
      // Spelled out rather than marked with a symbol: a bare "·" after the name reads as a
      // stray character, not as metadata.
      option.textContent = theme.dark ? `${theme.name} · dark` : theme.name
      group.appendChild(option)
    }
    select.appendChild(group)
  }

  const credit = document.createElement('span')
  credit.className = 'app-credit'

  async function select_(id: string): Promise<void> {
    const theme = await applyTheme(id)
    select.value = theme.id

    credit.replaceChildren()
    const link = document.createElement('a')
    link.href = theme.source
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = theme.pack
    credit.append(`${theme.author}/`, link, ` · ${theme.license}`)

    onChange?.(theme)
  }

  select.addEventListener('change', () => {
    void select_(select.value)
  })

  wrap.append(label, select, credit)
  return { element: wrap, select: select_ }
}
