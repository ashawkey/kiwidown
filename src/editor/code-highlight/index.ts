import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import type { Node } from '@milkdown/kit/prose/model'
import type { RootContent } from 'hast'

import { refractor, resolveLanguage } from './languages'
import { toCodeMirrorClass } from './token-map'

/*
 * Syntax highlighting for fenced code, in CodeMirror's vocabulary.
 *
 * Typora highlights fences with CodeMirror 5, so themes colour code through
 * `.cm-s-inner .cm-keyword` and friends — the largest single surface in the whole theme
 * set. ../typora-dom.ts puts `.md-fences.cm-s-inner` on the <pre>; this fills in the token
 * spans underneath it.
 *
 * Tokens are inline decorations rather than markup, which keeps the code block a plain
 * editable <pre> — no node view, no shadow copy of the text to keep in sync, and the
 * decorations simply map through edits until the next recompute.
 */

const key = new PluginKey<DecorationSet>('TYPORA_CODE_HIGHLIGHT')

const CODE_BLOCK = 'code_block'

interface TokenRun {
  text: string
  chain: string[]
}

/**
 * Flatten Prism's nested token tree into a linear list of text runs, each carrying the
 * class chain of every element enclosing it.
 *
 * The nesting is real and deep — `php > language-php > string > double-quoted-string >
 * interpolation > variable` occurs in practice — and the whole chain is kept so
 * `toCodeMirrorClass` can pick the innermost meaningful label.
 */
function flatten(nodes: readonly RootContent[], chain: string[] = []): TokenRun[] {
  const runs: TokenRun[] = []
  for (const node of nodes) {
    if (node.type === 'element') {
      const classes = (node.properties?.['className'] ?? []) as string[]
      runs.push(...flatten(node.children, [...chain, ...classes]))
    } else if (node.type === 'text') {
      runs.push({ text: node.value, chain })
    }
  }
  return runs
}

/**
 * Highlighting is pure in (language, code), and a document edit usually touches one block
 * while leaving every other one identical — so results are memoised and most fences are
 * skipped entirely on recompute. Bounded because an editing session would otherwise
 * accumulate an entry per keystroke.
 */
const CACHE_LIMIT = 64
const cache = new Map<string, TokenRun[]>()

function tokenize(language: string, code: string): TokenRun[] {
  const cacheKey = `${language}\u0000${code}`
  const hit = cache.get(cacheKey)
  if (hit) {
    // Refresh recency so the blocks being actively edited stay resident.
    cache.delete(cacheKey)
    cache.set(cacheKey, hit)
    return hit
  }

  let runs: TokenRun[]
  try {
    runs = flatten(refractor.highlight(code, language).children)
  } catch {
    // A grammar can throw on pathological input. Unhighlighted code is a fine outcome;
    // a broken editor is not.
    runs = []
  }

  cache.set(cacheKey, runs)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return runs
}

function build(doc: Node): DecorationSet {
  const decorations: Decoration[] = []

  doc.descendants((node, pos) => {
    if (node.type.name !== CODE_BLOCK) return true

    const language = resolveLanguage(node.attrs['language'] as string | undefined)
    if (!language) return false

    // Content starts one position inside the node. Offsets within the code text advance
    // one-for-one with document positions, since a code block holds only plain text.
    let from = pos + 1
    for (const run of tokenize(language, node.textContent)) {
      const to = from + run.text.length
      const cmClass = toCodeMirrorClass(run.chain)
      if (cmClass) {
        // Prism's own names ride along too, so a Prism stylesheet would work here as well.
        const prismClasses = run.chain.filter((c) => c !== 'token')
        decorations.push(
          Decoration.inline(from, to, { class: `token ${prismClasses.join(' ')} ${cmClass}` })
        )
      }
      from = to
    }

    return false
  })

  return DecorationSet.create(doc, decorations)
}

/** Token spans inside `pre.md-fences.cm-s-inner`, classed the way Typora themes expect. */
export const codeHighlight = $prose(
  () =>
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => build(state.doc),
        apply: (tr, value) => {
          // Selection-only transactions can't change any token, so the existing set stands.
          if (!tr.docChanged) return value
          // Otherwise rebuilt outright rather than mapped through the transaction: mapped
          // spans stay where the old text was, and an edit inside a fence re-tokenises it
          // anyway. The cache in `tokenize` is what keeps this cheap — every *other* fence
          // in the document hits it and is skipped.
          return build(tr.doc)
        },
      },
      props: {
        decorations(state) {
          return key.getState(state)
        },
      },
    })
)
