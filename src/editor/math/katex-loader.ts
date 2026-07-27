/*
 * KaTeX, loaded on demand.
 *
 * KaTeX is around 280 KB of JavaScript plus a stylesheet and a set of webfonts — more than
 * the rest of this application put together, and most documents contain no maths at all.
 * So it is imported dynamically the first time a formula appears; Vite splits it into its
 * own chunk and nothing is fetched until then.
 *
 * Until it arrives, formulas render as their raw TeX, which is legible and is what a plain
 * Markdown renderer would show anyway.
 */

type KatexModule = typeof import('katex')

let loading: Promise<KatexModule> | undefined
let loaded: KatexModule | undefined

/**
 * Load KaTeX and its stylesheet. Repeat calls share one in-flight promise.
 *
 * The stylesheet is imported rather than linked so Vite fingerprints it and rewrites the
 * font URLs inside it; loading the CSS by hand would leave those pointing at nothing.
 */
export function loadKatex(): Promise<KatexModule> {
  loading ??= (async () => {
    const [katex] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    loaded = katex
    return katex
  })()
  return loading
}

/**
 * Render TeX to HTML, or return `undefined` if KaTeX isn't loaded yet.
 *
 * Errors are rendered rather than thrown: `throwOnError: false` makes KaTeX emit the
 * offending source in its error colour, which tells the author exactly which formula is
 * wrong instead of blanking the document.
 */
export function renderMath(tex: string, displayMode: boolean): string | undefined {
  const katex = loaded
  if (!katex) return undefined
  return katex.default.renderToString(tex, {
    displayMode,
    throwOnError: false,
    output: 'html',
    strict: false,
  })
}
