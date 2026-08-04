import { footnoteDefinitionSchema } from '@milkdown/kit/preset/gfm'

/*
 * Re-shapes footnote definitions into Typora's markup.
 *
 * Milkdown emits a definition list:
 *
 *   <dl data-type="footnote_definition"><dt>1</dt><dd>…</dd></dl>
 *
 * Typora emits a labelled block, and themes style it directly through `.footnotes`,
 * `.md-def-footnote` and rules like `.md-def-footnote .md-def-name:before { content: "［" }`:
 *
 *   <div class="footnotes md-def-footnote md-end-block">
 *     <span class="md-def-name">1</span>
 *     <span class="md-def-split md-def-f"></span>
 *     <span class="md-def-content">…</span>
 *   </div>
 *
 * Left as a <dl>, none of that applies and the footnote renders as a bare label above an
 * indented paragraph.
 *
 * Unlike list items, this one is safe to reach with `extendSchema`. That method rebuilds
 * from the *original* schema factory, so it silently discards any extension already
 * applied — which is why task lists use decorations instead (GFM extends list_item), but
 * is harmless here, where nothing else touches footnote_definition.
 *
 * Both label and body are <span>s, matching Typora, because the whole footnote is meant to
 * read as one line — themes bracket the label with `.md-def-name:before/:after` and
 * expects the body to sit beside it, not under it. Milkdown's schema gives the body
 * `block+` content, so the paragraph inside it is re-flowed inline by src/theme/bridge.css.
 */
export const typoraFootnoteDefinition = footnoteDefinitionSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    parseDOM: [
      {
        tag: 'div[data-type="footnote_definition"]',
        getAttrs: (dom: HTMLElement | string) => {
          if (typeof dom === 'string') return false
          return { label: dom.dataset['label'] ?? '' }
        },
        contentElement: '.md-def-content',
      },
      ...(base.parseDOM ?? []),
    ],
    toDOM: (node) => [
      'div',
      {
        class: 'footnotes md-def-footnote md-end-block',
        'data-label': node.attrs['label'],
        'data-type': 'footnote_definition',
      },
      ['span', { class: 'md-def-name' }, node.attrs['label']],
      // Typora's spacer between the label and the body; themes size and decorate it.
      ['span', { class: 'md-def-split md-def-f' }],
      // The content hole must be the last entry of the array it appears in — which is why
      // the body gets its own wrapper rather than sitting beside the label in the <div>.
      ['span', { class: 'md-def-content' }, 0],
    ],
  }
})
