import { getThemes, THEME_CHANGE_EVENT } from '../theme'

const FONT_STORAGE_KEY = 'kiwidown.fontScale'
const WIDTH_STORAGE_KEY = 'kiwidown.documentWidth'
const FONT_SCALES = [80, 90, 100, 110, 120, 130, 140] as const
const DOCUMENT_WIDTHS = [40, 50, 60, 70, 80, 90] as const
const DEFAULT_FONT_SCALE = 100
const DEFAULT_DOCUMENT_WIDTH = 70

function savedChoice(key: string, choices: readonly number[], fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key))
    if (choices.includes(value)) return value
  } catch {
    // Private-mode storage failures should not disable the controls.
  }
  return fallback
}

function saveChoice(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // The setting still works for this session when storage is unavailable.
  }
}

function percentageSelect(
  label: string,
  shortLabel: string,
  choices: readonly number[],
  selected: number
): { element: HTMLElement; select: HTMLSelectElement } {
  const element = document.createElement('div')
  element.className = 'app-display-control'
  element.title = label

  const prefix = document.createElement('span')
  prefix.className = 'app-display-control__label'
  prefix.textContent = shortLabel
  prefix.setAttribute('aria-hidden', 'true')

  const select = document.createElement('select')
  select.className = 'app-display-control__select'
  select.setAttribute('aria-label', label)
  select.title = label
  for (const choice of choices) {
    const option = document.createElement('option')
    option.value = String(choice)
    option.textContent = `${choice}%`
    option.selected = choice === selected
    select.appendChild(option)
  }

  element.append(prefix, select)
  return { element, select }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/** Persistent font-size and reading-width controls shared by every document theme. */
export function createDisplayControls(): {
  element: HTMLElement
  refreshForTheme: (href?: string) => Promise<void>
} {
  const element = document.createElement('div')
  element.className = 'app-display-controls'
  element.setAttribute('aria-label', 'Document display')

  let fontScale = savedChoice(FONT_STORAGE_KEY, FONT_SCALES, DEFAULT_FONT_SCALE)
  let documentWidth = savedChoice(
    WIDTH_STORAGE_KEY,
    DOCUMENT_WIDTHS,
    DEFAULT_DOCUMENT_WIDTH
  )
  let refreshToken = 0

  const font = percentageSelect('Document font size', 'A', FONT_SCALES, fontScale)
  const width = percentageSelect('Document width', '↔', DOCUMENT_WIDTHS, documentWidth)
  element.append(font.element, width.element)

  function writeElement(): HTMLElement | null {
    return document.getElementById('write')
  }

  function clearAppliedFontSize(): void {
    document.documentElement.style.removeProperty('font-size')
    delete document.documentElement.dataset['fontScale']
    writeElement()?.style.removeProperty('font-size')
  }

  function applyFontSize(): void {
    const write = writeElement()
    if (!write) return

    // Read each theme's unscaled root and body sizes, then pin their scaled equivalents.
    // Scaling both handles themes whose body is fixed in px as well as headings sized in rem.
    clearAppliedFontSize()
    const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    const writeSize = Number.parseFloat(getComputedStyle(write).fontSize)
    const ratio = fontScale / 100
    document.documentElement.style.fontSize = `${rootSize * ratio}px`
    write.style.fontSize = `${writeSize * ratio}px`
    document.documentElement.dataset['fontScale'] = String(fontScale)
  }

  function applyDocumentWidth(): void {
    document.documentElement.style.setProperty('--app-doc-width', `${documentWidth}%`)
    document.documentElement.dataset['documentWidth'] = String(documentWidth)
  }

  font.select.addEventListener('change', () => {
    const next = Number(font.select.value)
    if (!FONT_SCALES.includes(next as (typeof FONT_SCALES)[number])) return
    fontScale = next
    applyFontSize()
    saveChoice(FONT_STORAGE_KEY, fontScale)
    // Mermaid measures label boxes while rendering, so regenerate it at the new size.
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
  })

  width.select.addEventListener('change', () => {
    const next = Number(width.select.value)
    if (!DOCUMENT_WIDTHS.includes(next as (typeof DOCUMENT_WIDTHS)[number])) return
    documentWidth = next
    applyDocumentWidth()
    saveChoice(WIDTH_STORAGE_KEY, documentWidth)
  })

  async function refreshForTheme(href?: string): Promise<void> {
    const token = ++refreshToken
    const activeId = document.documentElement.dataset['theme']
    const expectedHref = href ?? getThemes().find((theme) => theme.id === activeId)?.href
    clearAppliedFontSize()

    // The theme is attached through an imported stylesheet. Wait until the new import has
    // parsed before reading its baseline sizes; the old rule remains visible briefly.
    for (let frame = 0; frame < 120; frame++) {
      await nextFrame()
      if (token !== refreshToken) return
      const slot = document.getElementById('typora-theme-slot') as HTMLStyleElement | null
      const rule = slot?.sheet?.cssRules[0]
      const isExpected =
        !expectedHref || (rule instanceof CSSImportRule && rule.href.endsWith(expectedHref))
      if (isExpected && rule instanceof CSSImportRule && (rule.styleSheet?.cssRules.length ?? 0) > 0) break
    }
    // A parsed import becomes observable just before its rules affect computed styles.
    await nextFrame()
    if (token === refreshToken) applyFontSize()
  }

  applyDocumentWidth()
  void refreshForTheme()
  return { element, refreshForTheme }
}
