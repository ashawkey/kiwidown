import type { EditorState } from '@milkdown/kit/prose/state'

import type { DocumentState } from './index'
import type { EditorHandle } from '../editor'

/*
 * What the editor holds for each open document.
 *
 * The store knows a document's text; everything else about how it was left — where the
 * caret is, how far down the page you had read, what undo would do — lives only in the
 * editor, and there is one editor for all the tabs. So switching documents means putting
 * the outgoing one's editor state aside and bringing the incoming one's back.
 *
 * Reparsing the Markdown instead would be simpler and noticeably worse: every switch would
 * jump to the top of the file with an empty undo stack, which is exactly the sort of thing
 * that makes tabs feel like a trick rather than like having two files open.
 */

interface Retained {
  state: EditorState
  scrollTop: number
}

/** How long to keep holding the scroll position after a switch. */
const SETTLE_MS = 1200

/** Anything that means the user has taken the scroll back. */
const TAKEOVER = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

export interface DocumentViews {
  /** Show `next`, retaining what `previous` had open. */
  swap: (next: DocumentState, previous?: DocumentState) => void
  /** Replace the visible document's content outright — a load, not a switch. */
  replace: (markdown: string) => void
  /** A document was closed; drop what we kept for it. */
  forget: (id: string) => void
}

export function createDocumentViews(editor: EditorHandle, scroller: HTMLElement): DocumentViews {
  /** Only ever holds documents that are *not* in the editor; the visible one is live. */
  const retained = new Map<string, Retained>()
  let unpin: (() => void) | undefined

  /**
   * Put the scroll position back, and keep putting it back for a moment.
   *
   * A document's height isn't final when it renders: KaTeX reflows, Mermaid draws a
   * diagram, images arrive. Each of those grows the page above the viewport and carries
   * the scroll position with it, so a single assignment lands you somewhere else a beat
   * later. Holding it until the page settles is what makes returning to a long file
   * actually return you to where you were.
   */
  function pin(top: number): void {
    unpin?.()
    scroller.scrollTop = top

    const observer = new ResizeObserver(() => {
      if (Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top
    })
    // The scroller's own box doesn't change; its content is what grows.
    const content = scroller.firstElementChild
    if (content) observer.observe(content)

    const release = () => {
      observer.disconnect()
      window.clearTimeout(timer)
      for (const type of TAKEOVER) window.removeEventListener(type, release)
      unpin = undefined
    }
    const timer = window.setTimeout(release, SETTLE_MS)
    for (const type of TAKEOVER) window.addEventListener(type, release, { passive: true })
    unpin = release
  }

  return {
    swap(next, previous) {
      if (previous) {
        const state = editor.captureState()
        if (state) retained.set(previous.id, { state, scrollTop: scroller.scrollTop })
      }

      const kept = retained.get(next.id)
      if (kept) {
        editor.restoreState(kept.state)
        // It's live now, so the copy would only go stale.
        retained.delete(next.id)
      } else {
        editor.setMarkdown(next.text)
      }

      // Focus first, then place the scroll: focusing moves the caret into view, and doing
      // it the other way round would undo the restore in the same frame.
      editor.withView((view) => view.focus())
      pin(kept?.scrollTop ?? 0)
    },

    replace(markdown) {
      editor.setMarkdown(markdown)
      pin(0)
    },

    forget(id) {
      retained.delete(id)
    },
  }
}
