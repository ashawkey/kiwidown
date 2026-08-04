import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import type { Mark, Node } from '@milkdown/kit/prose/model'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'

/*
 * Typora's reveal-on-focus syntax markers.
 *
 * Put the caret inside a bold word in Typora and it becomes `**bold**`; move away and the
 * asterisks disappear again. Other bold words in the same paragraph stay rendered — the
 * markers belong to the element the caret is in, not to the block.
 *
 * Typora can do this with CSS alone because its markup keeps the punctuation in the
 * document as `.md-meta` spans and just hides them. ProseMirror's model has no such thing:
 * `**bold**` is text carrying a `strong` mark, and the asterisks exist nowhere. So they are
 * synthesised as widget decorations at the boundaries of whichever mark range contains the
 * caret.
 *
 * The spans carry `md-expand` alongside `md-meta` because `.md-meta` alone is
 * `display: none` — see the transcribed Typora rules in src/theme/compat.css. Themes then
 * colour them through `--md-char-color`; themes that do not set it inherit the
 * neutral grey compat.css falls back to.
 */

interface MetaState {
  decorations: DecorationSet
  /** Typora only expands markers while the editor actually has focus. */
  focused: boolean
}

const key = new PluginKey<MetaState>('TYPORA_MD_META')

/** Delimiters by mark type. Symmetric ones use the same string both sides. */
export const DELIMITERS: Readonly<Record<string, { open: string; close: string }>> = {
  strong: { open: '**', close: '**' },
  emphasis: { open: '*', close: '*' },
  inlineCode: { open: '`', close: '`' },
  strike_through: { open: '~~', close: '~~' },
  typora_highlight: { open: '==', close: '==' },
  typora_superscript: { open: '^', close: '^' },
  typora_subscript: { open: '~', close: '~' },
}

function meta(text: string, extraClass = ''): HTMLElement {
  const span = document.createElement('span')
  span.className = `md-meta md-expand${extraClass ? ` ${extraClass}` : ''}`
  span.textContent = text
  // Generated punctuation: it must not become part of the document if the browser tries
  // to fold it into an edit.
  span.contentEditable = 'false'
  return span
}

function widget(pos: number, node: HTMLElement, side: number, id: string): Decoration {
  return Decoration.widget(pos, () => node, { side, key: id, ignoreSelection: true })
}

/**
 * The contiguous run of `mark` around `cursor`, in document positions.
 *
 * A mark can appear several times in one paragraph, so this finds the specific run the
 * caret is inside rather than the first or the union of them.
 */
function runAround(block: Node, contentStart: number, cursor: number, mark: Mark): { from: number; to: number } | undefined {
  let pos = contentStart
  let from: number | undefined
  let to = contentStart

  for (let i = 0; i < block.childCount; i++) {
    const child = block.child(i)
    const childEnd = pos + child.nodeSize
    if (mark.isInSet(child.marks)) {
      from ??= pos
      to = childEnd
    } else {
      if (from !== undefined && cursor >= from && cursor <= to) return { from, to }
      from = undefined
    }
    pos = childEnd
  }

  return from !== undefined && cursor >= from && cursor <= to ? { from, to } : undefined
}

function build(state: EditorState, focused: boolean): DecorationSet {
  if (!focused) return DecorationSet.empty
  const { $anchor, $head, $from, empty } = state.selection
  // A range has no single inline element to expand. A selection contained by one heading,
  // however, must keep its `#` prefix: removing the widget on the first mouse movement
  // shifts the text under the pointer and makes drag selection jump.
  if (!empty && !$anchor.sameParent($head)) return DecorationSet.empty

  const decorations: Decoration[] = []
  const block = $from.parent
  if (!block.isTextblock) return DecorationSet.empty
  const contentStart = $from.start()
  const cursor = $from.pos

  // Heading level, shown as the `#` prefix Typora reveals when the caret is in a heading.
  if (block.type.name === 'heading') {
    const level = Number(block.attrs['level']) || 1
    decorations.push(widget(contentStart, meta(`${'#'.repeat(level)} `), -1, `heading-${level}`))
  }

  // Keep only the block-level heading marker for a range. Inline mark delimiters still
  // require a caret identifying which specific marked run is being edited.
  if (!empty) {
    return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty
  }

  // `$from.marks()` is what the caret is "inside", which is exactly the set Typora expands.
  for (const mark of $from.marks()) {
    const range = runAround(block, contentStart, cursor, mark)
    if (!range) continue

    if (mark.type.name === 'link') {
      // Links expose their target too: Typora shows `[text](url)`, with the URL as
      // .md-content rather than .md-meta so themes can style the two differently.
      const href = String(mark.attrs['href'] ?? '')
      const title = String(mark.attrs['title'] ?? '')
      const tail = document.createElement('span')
      tail.className = 'md-meta md-expand'
      tail.contentEditable = 'false'
      tail.append('](')
      const url = document.createElement('span')
      url.className = 'md-content md-expand md-url'
      url.textContent = title ? `${href} "${title}"` : href
      tail.append(url, ')')

      decorations.push(
        widget(range.from, meta('['), -1, 'link-open'),
        widget(range.to, tail, 1, `link-close-${href}`)
      )
      continue
    }

    const delimiter = DELIMITERS[mark.type.name]
    if (!delimiter) continue
    decorations.push(
      widget(range.from, meta(delimiter.open), -1, `${mark.type.name}-open`),
      widget(range.to, meta(delimiter.close), 1, `${mark.type.name}-close`)
    )
  }

  return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty
}

/** Reveals Markdown punctuation around whatever the caret is inside. */
export const mdMeta = $prose(
  () =>
    new Plugin<MetaState>({
      key,
      state: {
        init: (_, state) => ({ decorations: build(state, false), focused: false }),
        apply: (tr: Transaction, prev, _old, state) => {
          const flag = tr.getMeta(key) as boolean | undefined
          const focused = flag ?? prev.focused
          if (flag === undefined && !tr.docChanged && !tr.selectionSet) return prev
          return { decorations: build(state, focused), focused }
        },
      },
      props: {
        decorations(state) {
          return key.getState(state)?.decorations
        },
        handleDOMEvents: {
          focus: (view) => {
            view.dispatch(view.state.tr.setMeta(key, true))
            return false
          },
          blur: (view) => {
            view.dispatch(view.state.tr.setMeta(key, false))
            return false
          },
        },
      },
    })
)
