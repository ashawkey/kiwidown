import welcomeSource from './welcome.md?raw'

/*
 * The document a first visit opens with.
 *
 * It doubles as the input to `npm run check:contract`, which asserts its selector list
 * against whatever the app loads by default — so this file is not just copy. Every
 * construct in it is load-bearing for some check: front matter, a footnote pair, a task
 * list with both states, an `html` fence carrying tag/keyword/string/number tokens, a
 * `[TOC]` deep enough to span heading levels, inline and block math, and a diagram. Adding
 * to it is safe; removing from it will fail the contract run and tell you which selector
 * went missing.
 *
 * Written rather than vendored. It used to be Typora's own `lorem-ipsum.md`, which had the
 * advantage of being the reference implementation's document — but it fetched an image
 * from imgur on first paint, covered neither diagrams nor display math, and carried no
 * licence we could rely on.
 *
 * Two things here are deliberate and look like oversights:
 *
 * - The emoji is the literal character, not a `:shortcode:`. remark-gemoji resolves
 *   shortcodes to text at parse time and has no reverse, so a live shortcode would come
 *   back as the emoji and fail the round-trip check. The prose mentions shortcodes inside
 *   inline code, which isn't substituted.
 * - The image is `favicon.svg`, referenced relatively so it resolves against the app's own
 *   base URL under any deployment path — and so the first document a visitor sees makes no
 *   network request, which is the claim the README makes for the whole app.
 */

/**
 * The welcome document as Markdown.
 *
 * Deliberately kept in Markdown rather than a template literal: it is a `.md` file that
 * has to survive the same round-trip as anything a user opens, so it is edited, diffed and
 * reviewed as one.
 */
export function welcomeMarkdown(): string {
  return welcomeSource
}
