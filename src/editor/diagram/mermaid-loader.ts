/*
 * Mermaid, loaded on demand.
 *
 * Mermaid is by a wide margin the heaviest thing this project could depend on — it pulls
 * in d3, cytoscape, dagre and more, and weighs several hundred kilobytes gzipped. Most
 * documents contain no diagrams, so it is imported dynamically the first time a
 * ```mermaid fence renders, in its own Vite chunk. Nothing is fetched until then.
 */

type Mermaid = typeof import('mermaid')['default']

let loading: Promise<Mermaid> | undefined

function load(): Promise<Mermaid> {
  loading ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // The theme owns the colours: every vendored theme that styles diagrams does so by
      // overriding Mermaid's SVG classes under `.md-diagram-panel-preview`, usually with
      // !important. Mermaid's neutral theme gives them the plainest base to work from.
      theme: 'neutral',
      securityLevel: 'strict',
      fontFamily: 'inherit',
    })
    return mermaid
  })
  return loading
}

export type DiagramResult = { ok: true; svg: string } | { ok: false; message: string }

/**
 * Render `source` to SVG.
 *
 * Mermaid throws on invalid syntax, which is expected while a diagram is being typed —
 * so failures come back as a value rather than an exception, and the caller shows the
 * message instead of a blank or stale panel.
 */
export async function renderDiagram(
  id: string,
  source: string,
  container: Element
): Promise<DiagramResult> {
  try {
    const mermaid = await load()
    // `parse` validates without leaving Mermaid's error DOM attached to the body, which
    // `render` does on failure. Rendering in the eventual preview container is important:
    // Mermaid measures labels while drawing, and a body-level temporary SVG would use the
    // body font instead of the fence/panel font that the finished SVG inherits.
    await mermaid.parse(source)
    const { svg } = await mermaid.render(id, source, container)
    return { ok: true, svg }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
