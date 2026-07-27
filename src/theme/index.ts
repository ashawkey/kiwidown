import './compat.css'
import './bridge.css'

export interface ThemeEntry {
  /** `<pack>/<theme>`, e.g. `notion/notion-light`. Stable; used for persistence. */
  id: string
  name: string
  pack: string
  dark: boolean
  /** Path under public/themes/, e.g. `notion/themes/enhanced/notion-light-enhanced.css`. */
  href: string
  license: string
  author: string
  source: string
}

interface ThemeIndex {
  generated: string
  themes: ThemeEntry[]
}

const STORAGE_KEY = 'kiwidown.theme'
/** A clean, familiar light document. Falls back to whatever is first if it's ever dropped. */
const DEFAULT_THEME = 'notion/notion-light'

/** Resolve a path in public/ against the document base, so any deploy path works. */
function publicUrl(path: string): string {
  return new URL(path, document.baseURI).href
}

function slot(id: string): HTMLStyleElement {
  const el = document.getElementById(id)
  if (!(el instanceof HTMLStyleElement)) throw new Error(`#${id} missing from index.html`)
  return el
}

/**
 * Load Typora's own base.css and codemirror.css into `typora-base.vendor`.
 *
 * These live in public/ and are served untouched: they are the foundation every
 * community theme is written against, and rewriting them would defeat the point.
 * Injecting the @import from here (rather than inlining it in index.html) keeps Vite's
 * PostCSS pass from trying to bundle them at build time.
 */
export function installBaseLayer(): void {
  slot('typora-base-slot').textContent = [
    `@import url(${JSON.stringify(publicUrl('typora-base/base.css'))}) layer(typora-base.vendor);`,
    `@import url(${JSON.stringify(publicUrl('typora-base/codemirror.css'))}) layer(typora-base.vendor);`,
  ].join('\n')
}

let themes: ThemeEntry[] = []

export async function loadThemeIndex(): Promise<ThemeEntry[]> {
  const res = await fetch(publicUrl('themes/index.json'))
  if (!res.ok) throw new Error(`theme index: ${res.status} ${res.statusText}`)
  const index = (await res.json()) as ThemeIndex
  themes = index.themes
  return themes
}

export function getThemes(): ThemeEntry[] {
  return themes
}

/**
 * Point the theme slot at `theme`.
 *
 * The stylesheet is pulled in with `@import ... layer(typora-theme)` rather than
 * inlined, and that is load-bearing in two ways: relative `url()` references inside
 * the theme (webfonts, background images) resolve against the *theme file's* path
 * instead of the page's, so vendored themes work byte-for-byte unmodified; and the
 * whole sheet lands in a cascade layer, so our own chrome in `@layer app` outranks it
 * regardless of how specific the theme's selectors are.
 *
 * The stylesheet is fetched first purely to warm the HTTP cache, so that replacing
 * the slot swaps to already-downloaded CSS instead of flashing unstyled content.
 */
export async function applyTheme(id: string): Promise<ThemeEntry> {
  const theme = themes.find((t) => t.id === id)
  if (!theme) throw new Error(`unknown theme: ${id}`)

  const href = publicUrl(`themes/${theme.href}`)
  try {
    await fetch(href, { cache: 'force-cache' })
  } catch {
    // Preload is an optimisation; a failure here just means a brief flash.
  }

  slot('typora-theme-slot').textContent = `@import url(${JSON.stringify(href)}) layer(typora-theme);`

  // The active theme lives on <html> rather than in a module variable: the chrome's
  // light/dark rules read [data-theme-dark] from CSS, and the screenshot scripts read
  // [data-theme] to label what they just captured.
  document.documentElement.dataset['theme'] = theme.id
  document.documentElement.dataset['themeDark'] = String(theme.dark)
  try {
    localStorage.setItem(STORAGE_KEY, theme.id)
  } catch {
    // Private-mode storage failures shouldn't break theming.
  }
  return theme
}

/** The persisted choice if it still exists in the index, else the default, else the first theme. */
export function initialThemeId(): string {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(STORAGE_KEY)
  } catch {
    // ignore
  }
  const has = (id: string | null): id is string => Boolean(id) && themes.some((t) => t.id === id)
  if (has(saved)) return saved
  if (has(DEFAULT_THEME)) return DEFAULT_THEME
  const first = themes[0]
  if (!first) throw new Error('theme index is empty — run `npm run themes:fetch`')
  return first.id
}
