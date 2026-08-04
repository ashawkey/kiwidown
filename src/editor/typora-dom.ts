import { editorViewOptionsCtx } from '@milkdown/kit/core'
import {
  blockquoteAttr,
  bulletListAttr,
  codeBlockAttr,
  headingAttr,
  hrAttr,
  orderedListAttr,
  paragraphAttr,
} from '@milkdown/kit/preset/commonmark'
import type { Ctx } from '@milkdown/kit/ctx'

/*
 * Half of the DOM contract (doc/dom-contract.md): everything reachable through a node's
 * own attribute slice.
 *
 * Milkdown builds each node's DOM as `[tag, {...ctx.get(xAttr.key)(node)}, 0]`, so
 * overriding a slice is the supported way to add Typora's classes — no schema forking,
 * no node views, and it survives upstream changes to the schemas themselves.
 *
 * The other half — task lists and footnote references — can't be reached this way,
 * because their toDOM either ignores the slice or has no slice at all. Those are handled
 * with node decorations in ./typora-nodes.ts.
 */

/** Typora tags every top-level block with this. */
const END_BLOCK = 'md-end-block'

/**
 * Everything Typora puts on a code fence, flattened onto one <pre>.
 *
 * Shared with the node views in ./code-fence and ./diagram, which replace the schema's
 * toDOM outright and would otherwise have to keep a copy of this list in step.
 */
export const FENCE_CLASS = `${END_BLOCK} md-fences ty-contain-cm cm-s-inner CodeMirror-wrap`

export function applyTyporaDom(ctx: Ctx): void {
  /*
   * #write must land on the contenteditable element itself, not on a wrapper.
   *
   * Themes lean on direct-child selectors — `#write > h3.md-focus:before`,
   * `#write > ul:first-child`, `#write > *:first-child` — so an extra element between
   * #write and the blocks breaks them. `rootAttrsCtx` would do exactly that: it targets
   * Milkdown's outer `<div class="milkdown">` — which is why this goes through the view's `attributes`
   * prop instead — `.milkdown` is then flattened by src/theme/compat.css.
   */
  ctx.update(editorViewOptionsCtx, (prev) => ({
    ...prev,
    attributes: {
      ...(typeof prev.attributes === 'object' ? prev.attributes : {}),
      id: 'write',
      // Typora sets this on #write; a handful of themes hang layout off it.
      class: 'typora-editor',
      spellcheck: 'false',
    },
  }))

  ctx.set(paragraphAttr.key, () => ({ class: END_BLOCK }))
  ctx.set(blockquoteAttr.key, () => ({ class: END_BLOCK }))
  ctx.set(hrAttr.key, () => ({ class: `${END_BLOCK} md-hr` }))

  // Themes hang their own heading numbering off .md-heading.
  ctx.set(headingAttr.key, () => ({ class: `${END_BLOCK} md-heading` }))

  // No vendored theme currently keys off either of these. They stay because Typora emits
  // them and the contract is Typora's DOM, not the subset today's themes happen to reach
  // for — a theme written against `#write .ul-list li.md-task-list-item` is ordinary, and
  // adding the class back after the fact would mean finding out from a screenshot.
  ctx.set(bulletListAttr.key, () => ({ class: 'ul-list' }))
  ctx.set(orderedListAttr.key, () => ({ class: 'ol-list' }))

  /*
   * Code fences.
   *
   * Typora renders these through CodeMirror 5, so themes address the code text as
   * `.cm-s-inner .cm-keyword` and the container as `.md-fences` — together the single
   * largest proprietary surface in the theme set. We emit one flattened <pre> carrying all
   * of those class names at once
   * instead of reproducing CodeMirror's nested scaffold, which src/theme/compat.css then
   * re-points at the <pre> itself.
   *
   * The `.cm-*` token spans inside it come from ./code-highlight.
   */
  ctx.set(codeBlockAttr.key, () => ({
    pre: { class: FENCE_CLASS },
    code: {},
  }))
}
