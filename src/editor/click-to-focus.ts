import type { EditorView } from '@milkdown/kit/prose/view'

/*
 * Make the empty space around the document a place you can click to start writing.
 *
 * `#write` is only as tall as its content and only as wide as the theme's measure, so a
 * new or short document leaves most of the window outside the editable element entirely.
 * Clicking there does nothing — no caret, no focus — and on an empty document there is
 * nothing else to aim at, so it isn't obvious the page can be typed into at all.
 *
 * ProseMirror can't fix this itself: the clicks never reach it, because they land on the
 * scroll container rather than on `view.dom`.
 */

/**
 * Route clicks on the scroll container into the editor.
 *
 * Bound on `mousedown` rather than `click` so focus and caret placement happen before the
 * browser's own selection handling, which otherwise leaves the caret where it was and the
 * click feeling ignored.
 */
export function bindClickToFocus(container: HTMLElement, getView: () => EditorView | undefined): () => void {
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    const view = getView()
    if (!view) return

    // Clicks that already landed inside the editable content are ProseMirror's business.
    const target = event.target as globalThis.Node | null
    if (target && view.dom.contains(target) && target !== view.dom) return

    event.preventDefault()

    // Nearest position to the pointer — clicking level with a paragraph but out in the
    // margin should put the caret on that line, not at the end of the document.
    const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
    const pos = at ? at.pos : view.state.doc.content.size

    const { state } = view
    const selection = state.selection.constructor as unknown as {
      near: (resolved: ReturnType<typeof state.doc.resolve>, bias?: number) => typeof state.selection
    }
    view.dispatch(state.tr.setSelection(selection.near(state.doc.resolve(Math.min(pos, state.doc.content.size)))))
    view.focus()
  }

  container.addEventListener('mousedown', onMouseDown)
  return () => container.removeEventListener('mousedown', onMouseDown)
}
