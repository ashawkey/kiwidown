# The DOM contract

A Typora theme is a stylesheet written against a specific DOM. Reuse the themes, and you
inherit that DOM as a specification. This file is that specification: what the editor has
to emit for an unmodified community theme to style it correctly.

Everything here is derived from evidence, not guesswork — the vendored `base.css`, Typora's
own rendering of its reference document, and a scan of the vendored themes. That rendering
was read while this file was written and is not vendored: the claims below quote the part
of it they rest on, so the contract stands on its own.

Where a claim rests on how heavily the themes use something, the measurement is *not*
quoted. It changes every time a pack is added or dropped, and a stale count reads as a
fact that was checked. Run `npm run themes:stats` instead — it reports selector counts
per class against whatever is vendored today, and `--cm` breaks the CodeMirror token
classes out individually.

## Why this is tractable

Ranked by weight, the proprietary surface is `#write`, `.md-diagram`, the `.cm-*` token
classes, CodeMirror's own wrappers, `.md-fences`, `.md-toc` and `.md-focus`. After those
it falls off quickly, into a long tail of single-purpose classes — `.code-tooltip`,
`.md-rawblock`, `.md-meta-block`, `.md-footnote` — that a handful of themes each use a
handful of times.

Everything else is plain tag styling — `h1`, `p`, `blockquote`, `table`, `ul`, `code`.
So the proprietary surface is small and enumerable, and a headless editor that emits
semantic HTML is most of the way there already.

## Layers

```
@layer typora-base, typora-theme, typora-bridge, app;
@layer typora-base.vendor, typora-base.compat;
```

- `typora-base.vendor` — Typora's real `base.css` and `codemirror.css`, served unmodified
  from `public/typora-base/`.
- `typora-base.compat` — `src/theme/compat.css`. Recreates the parts of Typora's *app*
  environment themes depend on. Below the theme, because a theme is entitled to override
  any of it.
- `typora-theme` — the active theme, attached with
  `@import url(...) layer(typora-theme)`. The `@import` is load-bearing: relative
  `url()` references inside the theme resolve against the theme file's own path, so
  vendored themes work byte-for-byte unmodified.
- `typora-bridge` — `src/theme/bridge.css`. **Above** the theme, and that is the whole
  point: it undoes damage from elements Typora never emitted, which a theme cannot be
  expected to guard against. See below.
- `app` — our chrome. Declared last, so it outranks any theme selector regardless of
  specificity.

### Why `typora-bridge` has to outrank the theme

Milkdown renders fences as `<pre><code>`. Typora's fences contain no `<code>` at all — the
text lives in CodeMirror's elements. So themes style `code` purely as *inline* code, and
that lands on the `<code>` inside our fence. A `code { background-color; padding }` rule is
the plain case — a tinted, padded box painted around every line of every code block.
A bare `code { font-family }` is the quiet case: it silently overrides the fence's own
font.

The theme is not wrong; it is styling markup that, in Typora, only ever appears inline.
Correcting it from a lower layer is impossible, so the bridge sits above.

Keep that file small. Every rule in it is a place where the editor's DOM failed to match
this document and we patched it in CSS instead — real debt, not a design.

## Element contract

Inside `#write`:

| Markdown | Required DOM | Notes |
|---|---|---|
| root | `<div id="write">` | Must be the direct parent of block content — themes use `#write > h3` child selectors. In Milkdown this is `editorViewOptionsCtx.attributes`, **not** `rootAttrsCtx` (which targets the outer `.milkdown` wrapper, one level too high). |
| paragraph | `<p>` | native |
| heading | `<h1>`–`<h6>` | native; several themes drive `counter-increment` off these |
| blockquote | `<blockquote>` | native |
| hr | `<hr>` or `<div class="md-hr">` | |
| table | `<table>` `<thead>` `<tbody>` `<th>` `<td>` | native |
| bullet list | `<ul class="ul-list">` | no vendored theme keys off it today; Typora emits it and the contract is Typora's DOM |
| ordered list | `<ol class="ol-list">` | |
| task item | `<li class="task-list-item md-task-list-item task-list-done\|task-list-not-done">` with a leading `<input type="checkbox">` (`checked` on done items) | **both** class names; checked items expose both `[checked]` and `:checked` — see below |
| code fence | `<pre class="md-fences ty-contain-cm cm-s-inner CodeMirror-wrap" lang="…">` | `lang` only when tagged: claude uses `[lang]:not([lang=""])::before` |
| fence language field | `<div class="code-tooltip">` → `<input class="ty-input ty-input-after ty-cm-lang-input">` | `.code-tooltip` → `.ty-cm-lang-input` |
| fence tokens | `<span class="token … cm-keyword">` etc. | see below |
| footnote ref | `<sup class="md-footnote">` | |
| footnote def | `<div class="footnotes md-def-footnote md-end-block">` → `<span class="md-def-name">` + `<span class="md-def-split md-def-f">` + `<span class="md-def-content">` | see below |
| focused block | add `class="md-focus"`, ancestors `md-focus-container` | |
| syntax markers | `<span class="md-meta md-expand">`, `<span class="md-content">` | see below |
| front matter | `<pre class="md-meta-block md-end-block">` | `.md-meta-block`, styled by nearly every theme |
| `==highlight==` | `<mark>` | plain tag |
| `X^2^` / `H~2~O` | `<sup>` / `<sub>` | plain tags |
| `$math$` | `<span class="md-inline-math">` | themes place it through this container |
| `$$math$$` | `<div class="md-math-block md-rawblock md-end-block">` → `.md-rawblock-before` + `.md-rawblock-input` + `.md-rawblock-after` + `.md-rawblock-container` | `.md-math-block` + `.md-rawblock-*` |
| ` ```mermaid ` | `<pre class="md-fences md-diagram">` → `.md-diagram-panel` → `.md-diagram-panel-preview` | `.md-diagram…`, one of the heaviest selectors in the set |
| `[TOC]` | `<div class="md-toc">` → `<p class="md-toc-content">` → `<span class="md-toc-item md-toc-h1"><a class="md-toc-inner">` | `.md-toc`, styled by nearly every theme |

Every row above is asserted by `npm run check:contract`.

### Where each piece is implemented

Three mechanisms, chosen per construct — the choice is forced, not stylistic:

- **`src/editor/typora-dom.ts`** — node attribute slices. Milkdown builds node DOM as
  `[tag, {...ctx.get(xAttr.key)(node)}, 0]`, so overriding a slice is the supported way to
  add classes. Used wherever the node's `toDOM` actually consults its slice.
- **`src/editor/typora-nodes.ts`** — node decorations, for task lists and footnote
  references. See below.
- **`src/editor/footnote-definition.ts`** — `extendSchema`, for footnote definitions,
  whose structure has to change rather than just gain classes.

### `extendSchema` is not safe on `list_item`

`extendSchema` rebuilds from the schema factory captured when `$nodeSchema` was first
called, not from whatever extension is currently in effect:

```js
result.extendSchema = (handler) => $nodeSchema(id, handler(schema))
```

GFM already uses it on `listItemSchema` to add task-list support. Calling it again from
here would take `prev` to be *commonmark's* factory and silently discard GFM's work.

So task lists use node decorations instead, which layer onto whatever the schemas produce.
Footnote definitions can use `extendSchema` safely, because nothing else extends them.

### Task list checkboxes must be widget decorations

GFM's task-list `toDOM` emits a bare `<li data-checked>` — no classes, no checkbox, and it
never consults `listItemAttr`. The checkbox can't be added in `toDOM` either: ProseMirror
requires the content hole to be the only child of its array, so `['li', attrs, ['input'], 0]`
is rejected outright.

A widget decoration at `pos + 1` — the first position inside the list item, before its
paragraph — renders as a direct child of the `<li>`, which is what `base.css`'s
`.md-task-list-item > input` and the themes' `li.md-task-list-item.task-list-done::before`
both require. Checked widgets set both the live `checked` property and the boolean
`checked` attribute: LightMind selects `:checked`, others select `[checked]`. Emitting one
alone breaks half of them, so both are required.

### Fence tokens carry CodeMirror's class names, not Prism's

Typora highlights fenced code with CodeMirror 5, so themes colour it through
`.cm-s-inner .cm-keyword`, `.cm-string`, and so on — the largest proprietary surface in
the whole theme set, with nearly every stylesheet colouring the core token classes. Ship
Prism's own `token keyword` names and none of it matches: code renders in one flat colour
while every selector still resolves, which is exactly the kind of failure the DOM
assertions can't see.

So `src/editor/code-highlight/` tokenises with Prism and relabels the output.
`token-map.ts` holds the translation; both sets of names are emitted, so a Prism
stylesheet would work here too. Tokens are inline decorations, which keeps the fence a
plain editable `<pre>` with no node view and no second copy of the text to keep in sync.

The map's targets come from what the themes style. Its *sources* have to come from what
Prism actually emits, which is undocumented and differs per grammar — so
`npm run probe:tokens` derives them, tokenising dense samples in 17 languages and
reporting every token chain plus what it resolves to. It currently maps 71% of token runs;
essentially all of the remainder is `punctuation`, which is deliberately left alone because
CodeMirror leaves it in the body colour. Re-run it after touching the map.

Prism nests tokens, so a run of text arrives labelled with every ancestor's classes —
`php > language-php > string > double-quoted-string > interpolation > variable` is real.
The chain is read from the inside out and the first recognised type wins, which is also
what lets structural wrappers like `language-php` or `regex-source` stay unmapped without
swallowing their contents.

### `~x~` must not be strikethrough

Typora reads `~x~` as subscript (`H~2~O`) and reserves `~~x~~` for strikethrough.
remark-gfm defaults to accepting a single tilde as strikethrough, which rewrites `H~2~O`
to `H~~2~~O` on save — corrupting the document rather than merely failing to render it. So
the editor sets `singleTilde: false`.

Turning it off is also what frees the delimiter: `src/editor/typora-inline/` then reads
`~x~` as a subscript mark, exactly as Typora does, and writes it back out the same way.

A tilde that *isn't* subscript is still escaped to `\~` on the way out, because remark-gfm
declares `~` unsafe in phrasing content. That is equivalent Markdown and, importantly,
*stable* — `check:contract` asserts serialisation is a fixed point, so backslashes can't
accumulate across saves.

### Task lists need both class names

`base.css` keys the layout entirely on the newer name:

```css
.md-task-list-item        { position: relative; list-style-type: none }
.md-task-list-item > input{ position: absolute; margin-left: -1.2em; margin-top: calc(1em - 10px) }
.task-list-item.md-task-list-item { padding-left: 0 }
```

while some vendored themes still target the bare `.task-list-item`. Emitting only one
name visibly breaks the other half: with
`md-task-list-item` missing, items keep their native bullet and the checkbox is pushed
onto its own line. Emit both.

This was found the hard way: Typora's own reference rendering predates the rename and
emits only `.task-list-item`, so following it alone produces exactly the broken layout
above. `check:contract` asserts both names.

### Markers must be synthesised, not hidden

Typora can do reveal-on-focus with CSS alone because its markup keeps the punctuation in
the document as `.md-meta` spans and merely hides them. ProseMirror's model has no such
thing: `**bold**` is text carrying a `strong` mark, and the asterisks exist nowhere at all.

So `src/editor/md-meta.ts` synthesises them as widget decorations at the boundaries of
whichever mark range contains the caret — matching Typora, where other bold words in the
same paragraph stay rendered. The spans carry `md-expand` alongside `md-meta`, because
`.md-meta` on its own is `display: none`.

### Syntax markers are app behaviour, not theme behaviour

Typora keeps Markdown punctuation in the DOM and hides it until the caret arrives:

```css
.md-meta, .md-content { display: none }
.md-expand .md-meta, .md-expand .md-content { display: inline }
```

Those rules live in Typora's `base-control.css` — a 104 KB app stylesheet that is
otherwise all chrome we have no counterpart for (sidebar, quick-open, menus). Rather than
vendor it, the handful of rules that matter are transcribed into `compat.css`. Without
them every document renders with its raw `**`/`[](…)` markup showing.

`src/editor/md-meta.ts` drives `.md-expand` from the editor selection. With the editor
unfocused nothing carries it and the markers stay hidden, which is the correct resting
state.

### Code fences

Typora renders fences through CodeMirror 5, so themes reach for CodeMirror's DOM
(`.cm-s-inner`, `.CodeMirror-wrap`, `.CodeMirror-code`, `.CodeMirror-gutters`) and colour
tokens via `.cm-s-inner .cm-keyword` and friends. This is the single largest proprietary
surface, and it is why the highlighter maps tokens onto `cm-*` class names rather than
shipping Prism or Shiki classes.

Do **not** blanket-override CodeMirror's layout properties in compat. An earlier
`.CodeMirror-sizer { margin-left: 0 !important }` — copied from a small-screen media query
in `base.css` where gutters are also hidden — slid line-numbered code underneath its own
gutter. The flattened `<pre>` we emit has no sizer at all, so the rule was inert in
production and harmful only against real CodeMirror markup.

### Blocks whose syntax has been eaten

A WYSIWYG editor consumes the text that created a block. The ` ```bash ` line and the `$$`
that opened a formula are both gone the moment the block exists, so unless something takes
their place those blocks can be created and then never changed again. Typora answers this
the same way twice, and both answers are markup themes already know:

- **The fence's language** lives in an `input.ty-cm-lang-input` inside a `.code-tooltip`,
  which Typora positions from its app code rather than from `base.css`. So compat places it
  in the bottom-right corner and themes move it where they want it — claude relocates it to
  the top-left and draws its own `attr(lang)` label, others hang it under the block as a tab
  (`top: 100%`). That last one is why `.md-fences` must **not** be a scroll container:
  the fence would clip a field the theme deliberately puts outside it. The scroller is the
  `<code>` instead, which is also where Typora has it (`.CodeMirror-scroll`, inside).
- **A formula's source** is an `md-rawblock`: `.md-rawblock-input` holding the TeX,
  bracketed by the `$$` lines as `.md-rawblock-before`/`-after`, with the rendered output
  in `.md-rawblock-container` beside it — not inside it, so the source can be hidden while
  the formula stays visible. Bridge reveals the source only on `.md-focus`, which is
  Typora's behaviour and the same arrangement the diagram fence uses.

Inline maths has nowhere to put a second line, so it stays an atom: selecting it (a click,
or arrowing into it) swaps the rendered output for `<span class="md-meta">$</span>` around
an editable `.md-content`, the same vocabulary the syntax markers use.

## Verifying

`npm run check:contract` asserts every row of the element table against the live editor,
plus three properties that aren't about the DOM but decide whether this is usable as an
editor at all:

- **Markdown round-trips** — load, serialise, compare. Modulo the delimiter spellings
  remark normalises (`+ x` → `* x`, `_em_` → `*em*`, `----` → `***`, bare URL →
  `<url>`, `~` → `\~`), which are equivalent CommonMark. Anything else is corruption.
- **Serialisation is a fixed point** — normalising once is fine; normalising *again* on
  every save would rewrite the user's file a little more each time.
- **Typing reaches both the DOM and the Markdown.**
- **A document change re-highlights fences** at the right positions.
- **The theme genuinely colours tokens** — token colours are compared against the fence
  body colour, because classes existing is not the same as a theme's rules reaching them.

One note on how those last checks are driven. Real keyboard input covers the heading edit,
but the fence check applies a transaction directly through the test hook. Driving it with
synthetic clicks meant aiming at an eight-pixel token span in a document whose height had
just changed; it failed unpredictably, retries didn't help, and when it failed it was
testing Playwright rather than the highlighter.

`npm run themes:shoot` then renders the document under every vendored theme and writes
full-page screenshots to `test/shots/`. The checks say the DOM is right; the screenshots
say it *looks* right, and only the second catches a compat rule that quietly breaks
layout. Reviewing them is how all three bugs recorded in this file were found.

## Known gaps

**Raw inline HTML renders as text.** `<u>underline</u>` stays literal where Typora would
render it. This is deliberate: `?src=` loads a document from any URL, and rendering its HTML
would execute whatever that document contains. Restoring it needs sanitisation, not just
switching the node on.

**Fences carry no line-number gutter.** Typora renders one inside CodeMirror's scaffold
(`.CodeMirror-gutters`, `.CodeMirror-linenumber`), which the flattened `<pre>` has no
equivalent for. Themes style it when present but none require it.

**`.MathJax` rules don't apply.** Typora renders maths with MathJax and some themes have
`.MathJax` rules; we use KaTeX. The container classes those themes rely on for placement —
`.md-math-block`, `.md-inline-math` — are emitted correctly, so what's lost is glyph-level
styling that MathJax's own stylesheet would otherwise have supplied.

**Emoji shortcodes are resolved, not preserved.** `:tada:` saves back as 🎉, because
remark-gemoji rewrites them at parse time. The text reads the same everywhere; the
shortcode spelling is gone.

**Only refractor's curated common set of grammars is bundled.** An unrecognised
language renders as plain text, silently, which is what Typora does too.

Legacy Typora diagram fences (`sequence`, `flow`) are not supported; Mermaid's own syntax
covers the same diagram types.
