import { defaultValueCtx, Editor, editorViewCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { cursor } from '@milkdown/kit/plugin/cursor'
import { history } from '@milkdown/kit/plugin/history'
import { indent } from '@milkdown/kit/plugin/indent'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { trailing } from '@milkdown/kit/plugin/trailing'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm, remarkGFMPlugin } from '@milkdown/kit/preset/gfm'
import { replaceAll } from '@milkdown/kit/utils'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

import { blockEnter } from './block-enter'
import { codeFence } from './code-fence'
import { codeHighlight } from './code-highlight'
import { typoraFootnoteDefinition } from './footnote-definition'
import { frontMatter } from './front-matter'
import { math } from './math'
import { mdFocus } from './md-focus'
import { mdMeta } from './md-meta'
import { toc } from './toc'
import { typoraInline } from './typora-inline'
import { typoraNodes } from './typora-nodes'
import { applyTyporaDom } from './typora-dom'

export interface EditorHandle {
  /** Current document as Markdown. */
  getMarkdown: () => string
  /** Replace the whole document, discarding undo history. */
  setMarkdown: (markdown: string) => void
  /** Run `fn` with the live ProseMirror view. */
  withView: (fn: (view: EditorView) => void) => void
  /** Snapshot the editor: document, selection and undo history. */
  captureState: () => EditorState | undefined
  /** Put a snapshot from {@link captureState} back in the editor. */
  restoreState: (state: EditorState) => void
  destroy: () => Promise<void>
}

export interface EditorOptions {
  root: HTMLElement
  defaultValue: string
  onChange?: (markdown: string) => void
}

/*
 * Milkdown, configured to emit Typora's DOM.
 *
 * Deliberately assembled from core presets rather than @milkdown/crepe: Crepe ships an
 * opinionated stylesheet that would compete with whichever theme is loaded, and the whole
 * premise here is that the theme owns the appearance. Milkdown's core is headless, so the
 * only styling in play is Typora's base.css and the active theme.
 *
 * Also skipped: @milkdown/kit/component/code-block. It renders
 * `<div class="milkdown-code-block">`, which `#write .md-fences` would never match. Plain
 * <pre> from preset-commonmark plus classes from typora-dom.ts matches the contract
 * instead, and ./code-fence re-adds the language picker as the markup Typora themes
 * already style.
 */
export async function createEditor(options: EditorOptions): Promise<EditorHandle> {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, options.root)
      ctx.set(defaultValueCtx, options.defaultValue)

      // Must run after the presets have registered their slices, which is exactly what
      // config() guarantees — it is applied once plugins are in place.
      applyTyporaDom(ctx)

      /*
       * Typora reads `~x~` as subscript (H~2~O) and reserves `~~x~~` for strikethrough.
       * remark-gfm defaults to treating a single tilde as strikethrough too, which
       * silently rewrites `H~2~O` to `H~~2~~O` on save — corrupting the document rather
       * than merely failing to render it.
       *
       * Turning single-tilde off is also what frees `~` for ./typora-inline, which reads
       * `H~2~O` as a subscript mark the way Typora does.
       */
      ctx.set(remarkGFMPlugin.options.key, { singleTilde: false })

      if (options.onChange) {
        ctx.get(listenerCtx).markdownUpdated((_, markdown) => options.onChange?.(markdown))
      }
    })
    .use(commonmark)
    .use(gfm)
    // Keep Tab inside the editor. List/table shortcuts registered by the presets run first;
    // elsewhere this inserts Milkdown's default two-space Markdown indentation.
    .use(indent)
    .use(history)
    .use(clipboard)
    .use(cursor)
    .use(trailing)
    .use(listener)
    // After gfm: this re-registers the footnote_definition node, so it has to win.
    .use(typoraFootnoteDefinition)
    .use(frontMatter)
    .use(typoraInline)
    .use(math)
    .use(toc)
    .use(typoraNodes)
    .use(codeHighlight)
    .use(codeFence)
    .use(blockEnter)
    .use(mdFocus)
    .use(mdMeta)
    .create()

  return {
    getMarkdown: () => {
      let markdown = ''
      editor.action((ctx) => {
        // Round-trips through remark, so this is the real source text — not doc.textContent,
        // which would flatten the document to bare prose.
        markdown = ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)
      })
      return markdown
    },
    setMarkdown: (markdown) => {
      // `flush` rebuilds the editor state rather than replacing the document in place,
      // which is what we want when opening a different file: undo shouldn't be able to
      // walk backwards into the previous document's content.
      editor.action(replaceAll(markdown, true))
    },
    withView: (fn) => {
      editor.action((ctx) => fn(ctx.get(editorViewCtx)))
    },
    /*
     * Switching documents is a state swap, not a reload.
     *
     * An EditorState carries the document, the selection and every plugin's state — undo
     * history included — so putting one back restores the tab exactly as it was left,
     * rather than reparsing its Markdown into a fresh editor that can't undo anything.
     * `replaceAll(md, true)` does the same `updateState` with a state built from scratch,
     * which is what makes this supported rather than a trick: same schema, same plugins,
     * same view.
     */
    captureState: () => {
      let state: EditorState | undefined
      editor.action((ctx) => {
        state = ctx.get(editorViewCtx).state
      })
      return state
    },
    restoreState: (state) => {
      editor.action((ctx) => ctx.get(editorViewCtx).updateState(state))
    },
    destroy: async () => {
      await editor.destroy()
    },
  }
}
