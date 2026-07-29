import { $inputRule, $markAttr, $markSchema, $remark } from '@milkdown/kit/utils'
import { markRule } from '@milkdown/kit/prose'
import remarkGemoji from 'remark-gemoji'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { remarkTyporaInline } from './remark-typora-inline'

/*
 * Typora's inline extensions, as Milkdown marks.
 *
 * Each pairs a mdast node type produced by ./remark-typora-inline with the element Typora
 * renders it to, so themes style them through plain tag selectors — `#write mark`,
 * `sub`, `sup` — exactly as they do in Typora.
 */

export const highlightAttr = $markAttr('typora_highlight')

/** `==text==` → `<mark>`. Themes style `mark` directly, as our own Su and Qi do. */
export const highlightSchema = $markSchema('typora_highlight', (ctx) => ({
  parseDOM: [{ tag: 'mark' }],
  toDOM: (mark) => ['mark', ctx.get(highlightAttr.key)(mark)],
  parseMarkdown: {
    match: (node) => node.type === 'highlight',
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'typora_highlight',
    runner: (state, mark) => {
      state.withMark(mark, 'highlight')
    },
  },
}))

export const superscriptAttr = $markAttr('typora_superscript')

/** `X^2^` → `<sup>`. base.css already styles `sup > .md-meta`, so Typora agrees. */
export const superscriptSchema = $markSchema('typora_superscript', (ctx) => ({
  parseDOM: [{ tag: 'sup' }],
  toDOM: (mark) => ['sup', ctx.get(superscriptAttr.key)(mark)],
  parseMarkdown: {
    match: (node) => node.type === 'superscript',
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'typora_superscript',
    runner: (state, mark) => {
      state.withMark(mark, 'superscript')
    },
  },
}))

export const subscriptAttr = $markAttr('typora_subscript')

/** `H~2~O` → `<sub>`. Only unambiguous because single-tilde strikethrough is off. */
export const subscriptSchema = $markSchema('typora_subscript', (ctx) => ({
  parseDOM: [{ tag: 'sub' }],
  toDOM: (mark) => ['sub', ctx.get(subscriptAttr.key)(mark)],
  parseMarkdown: {
    match: (node) => node.type === 'subscript',
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'typora_subscript',
    runner: (state, mark) => {
      state.withMark(mark, 'subscript')
    },
  },
}))

const remarkTyporaInlinePlugin = $remark('typoraInline', () => remarkTyporaInline)

/*
 * `:shortcode:` → the actual emoji character.
 *
 * remark-gemoji resolves them to text at parse time, which is what Typora does. The
 * alternative, Milkdown's own emoji plugin, renders Twemoji <img> tags and pulls in
 * twemoji and dompurify to do it — heavier, and it would need theme rules that no Typora
 * theme has.
 *
 * The trade-off is that shortcodes are resolved rather than preserved: `:tada:` saves back
 * as 🎉. That matches how the text now reads, and every renderer shows it identically.
 */
const remarkGemojiPlugin = $remark('gemoji', () => remarkGemoji)

/** Live input rules, so typing the syntax applies the mark immediately. */
export const highlightInputRule = $inputRule((ctx) =>
  markRule(/(?:==)([^=]+)(?:==)$/, highlightSchema.type(ctx))
)

export const superscriptInputRule = $inputRule((ctx) =>
  markRule(/(?:\^)([^\s^]+)(?:\^)$/, superscriptSchema.type(ctx))
)

export const subscriptInputRule = $inputRule((ctx) =>
  markRule(/(?:~)([^\s~]+)(?:~)$/, subscriptSchema.type(ctx))
)

export const typoraInline: MilkdownPlugin[] = [
  remarkTyporaInlinePlugin,
  remarkGemojiPlugin,
  highlightAttr,
  highlightSchema,
  superscriptAttr,
  superscriptSchema,
  subscriptAttr,
  subscriptSchema,
  highlightInputRule,
  superscriptInputRule,
  subscriptInputRule,
].flat()
