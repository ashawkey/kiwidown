# 🥝 Kiwidown

A static, browser-based WYSIWYG Markdown editor that renders with **real Typora themes** — the ones the community has already written, used unmodified.

**Live demo:** [md.kiui.moe](https://md.kiui.moe)

## Features

| | |
|---|---|
| **WYSIWYG** | Typora-style. Syntax markers appear only around what the caret is inside. Typing ` ```lang ` or `$$` and pressing Enter opens the block, and both stay editable afterwards — the fence through its language field, the formula through its source. |
| **Themes** | Four of our own — **Su 素**, **Qi 漆**, and the two glazed in Liquid Glass, **璃素** and **璃漆** — plus 6 real Typora themes, used unmodified. Switch live; the choice persists. The document's width is ours, not the theme's, so switching restyles the page without rewrapping it. |
| **Files** | Open/save actual `.md` files where the browser allows it, download elsewhere. `Ctrl+O`, `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+Alt+N`. The name in the tab is editable and is what the save dialog suggests. |
| **Tabs** | Several documents open at once. Switching keeps each one's scroll position, selection and undo history. `Ctrl+Alt+←`/`→` to move between them, `Ctrl+Alt+W` or middle-click to close. |
| **Never loses work** | Autosaves *every* unsaved document to a recovery buffer; offers to restore them after a crash; warns before closing with unsaved changes. |
| **Markdown is the file** | Round-trips through remark. Nothing is stored that isn't in the `.md`. |
| **Static** | No server, no account, no network after load. |

## Getting started

```sh
npm install
npm run dev            # http://localhost:5173
```

Vendored assets are committed, so this works offline. To refresh them:

```sh
npm run base:fetch     # Typora's base.css + codemirror.css
npm run themes:fetch   # community themes → public/themes/
npm run fonts:fetch    # LXGW WenKai → public/fonts/
```

## Scripts

| script | what it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | typecheck + production build to `dist/` |
| `npm run themes:fetch` | reconcile `public/themes/` with `themes.manifest.json` |
| `npm run fonts:fetch` | reconcile `public/fonts/` with `fonts.manifest.json` |
| `npm run themes:stats` | report how heavily the vendored themes use each Typora class |
| `npm run base:fetch` | vendor Typora's base stylesheets |
| `npm run check:contract` | assert the editor emits the DOM themes need |
| `npm run themes:shoot` | screenshot whole documents under every theme → `test/shots/` |
| `npm run ui:shoot` | screenshot the chrome in real layout → `test/shots-ui/` |
| `npm run smoke` | headless check that the dev server boots and a theme applies |
| `npm run probe:tokens` | report Prism's token vocabulary and how much of it maps |

`check:contract` is the main regression net: themes are stylesheets written against a
specific DOM, so "does it still look right" mostly reduces to "does it still emit the right
elements and classes", which a machine can answer. It also checks that Markdown
round-trips, that serialisation is a fixed point, and that typing works.

`themes:shoot` covers what the assertions can't — it catches a compat rule that quietly
breaks layout while every selector still matches. Both drive the locally installed Chrome
(no Playwright browser download). `smoke` covers the dev server specifically, since Vite
resolves `public/` differently there than in a production build.

`scripts/inspect-dom.mjs` is a debugging aid, not part of the checks: it dumps every child
of `#write` with its geometry and computed visibility, which is how you tell "the theme
didn't apply" apart from "the element rendered but painted nothing".

`themes:stats` exists so that no count has to be written down. Whether a Typora class is
worth emitting depends on how many themes reach for it, and that answer changes every time
a pack is added or dropped — so the numbers live in the script's output rather than in a
comment that quietly stops being true.

## How it works

Cascade layers, declared up front in `index.html` so ordering never depends on how
stylesheets happen to load:

```
@layer typora-base, typora-theme, typora-bridge, app;
```

- **`typora-base`** — Typora's own `base.css` and `codemirror.css`, served unmodified from
  `public/typora-base/`, plus `src/theme/compat.css`, which recreates the parts of Typora's
  app environment that themes assume exist. Below the theme, so a theme can override it.
- **`typora-theme`** — the active theme, attached with
  `@import url(...) layer(typora-theme)`. Importing rather than inlining is what lets a
  theme's relative font and image references keep resolving, so themes need no rewriting.
- **`typora-bridge`** — the few corrections that must outrank the theme, because they
  compensate for elements Typora never emitted and a theme therefore never guarded
  against.
- **`app`** — our own chrome, declared last so it always outranks a theme.

Switching themes rewrites a single `<style>` element. Themes are vendored byte-for-byte,
with one exception: `@font-face` and `@import` rules pointing at files we don't ship are
removed at fetch time. Leaving them meant a request for a missing file, answered on a
single-page site with `index.html`, which the browser then tried to parse as a font.

The toolbar floats over the document rather than sitting above it, so its Liquid Glass
material has real content to blur and tint — the theme scrolls underneath and shows
through.

**Every tab shares one editor.** Switching documents swaps ProseMirror's `EditorState`
rather than reparsing Markdown into a fresh editor: a state carries the document, the
selection and every plugin's state, so undo still knows what you did in a tab you left ten
minutes ago. It's the same `updateState` call Milkdown's own `replaceAll(md, true)` makes,
against the same schema and plugins. Scroll position isn't in the state — that's the
scroll container's — so it is recorded alongside and *held* for a moment after the switch,
because a document's height isn't final until KaTeX, Mermaid and any images have finished
and each of those would otherwise drag the page out from under you. See
[`src/doc/views.ts`](src/doc/views.ts).

**The document's width is ours.** Themes disagree wildly — 752px in Claude, 1100px in
LightMind, a full 21cm sheet in LaTeX — so switching
theme used to rewrap every line. `#write` gets `max(70%, min(100%, 560px))` from
`@layer app`, which outranks the theme without needing `!important`: 70% of the window on
a desktop, a full line of prose on a tablet, and the whole screen on a phone, with no
breakpoint in between. Horizontal padding is still the theme's, since that gutter is part
of how a theme looks — except below 600px, where several themes' 56–64px would spend a
third of the screen on margins.

The editor is Milkdown (ProseMirror + remark), assembled from core presets and configured
to emit Typora's DOM — see [`doc/dom-contract.md`](doc/dom-contract.md). Crepe and
Milkdown's code-block component are both deliberately skipped: they ship markup and CSS
that would compete with the theme.

Fenced code is tokenised with Prism and relabelled with **CodeMirror 5's** class names,
because that's what Typora uses and therefore what themes colour against — `.cm-keyword`,
`.cm-string`, and so on. Emitting Prism's own names would leave the largest single
surface in the theme set unmatched, and code rendering in one flat colour.

**Weight.** About 190 kB gzipped loads up front. KaTeX (78 kB) and Mermaid (~300 kB across
several chunks) are dynamically imported the first time a document actually contains a
formula or a diagram, so most documents never fetch them.

**Raw inline HTML is shown as text, not rendered.** Typora renders it; we don't, because
`?src=` will load a document from any URL and rendering its HTML would execute whatever it
contains.

## Themes

### Ours

Four built-in themes, written here rather than ported from anywhere. **Su** (素, undyed silk)
is a white page in warm charcoal; **Qi** (漆, lacquer) is the same document in a warm
near-black with raw-silk text. They share one hue — a muted vermilion, 朱, the red of a seal —
used only where something is being pointed at: links, inline code, footnote marks, the
highlight, and the short segment that opens the rule under the title. Su is the theme the
editor opens with.

Both set their body text in [LXGW WenKai](https://github.com/lxgw/LxgwWenKai) (霞鹜文楷), a
Kai-style CJK face, which is why the leading is generous and the type a step larger than
Typora's 14px — Kai reads small.

**Glassy Su 璃素** and **Glassy Qi 璃漆** are those same two seen through glass — 璃 as in
琉璃, glazed. Same face, same ink, same vermilion in the same few places; what changes is
that the page stops being paper. Following Apple's Liquid Glass, the material is a stack
rather than a colour, and it needs something behind it to be glass *about*: a wide, soft
field of colour on the page, `#write` floating over it as a frosted sheet that blurs and
saturates what it covers, blocks inside forming a second layer of glass on the first, and a
specular hairline along every top edge where light would catch. `#write::before` adds a
masked ring of deeper blur just inside the rim, because a lens bends light most where it
curves. Because the document scrolls *under* the toolbar — itself the same material — the
two read as one surface, and the sheet's tint drifts as it travels over the field.

The one thing translucency can break is legibility, so both panes stay opaque enough that
ink never sits directly on the field, and their text is pushed a step further from the
ground than in Su and Qi, where the page was a known colour.

All four live in `public/themes/kiwi/` and are marked `"local": true` in the manifest, which
means `themes:fetch` indexes and reference-checks them but never downloads or deletes them.
Structure lives in `kiwi.css` and the material in `glassy.css`; `su.css`, `qi.css`,
`glassy-su.css` and `glassy-qi.css` are palettes and nothing else, so none of them can drift
apart. The glazed pair load `kiwi.css` first and then `glassy.css`, so they inherit every
answer to the DOM contract and restate only what the material changes.

The font is the one vendored asset that isn't a theme. It sits in `public/fonts/`, listed in
`fonts.manifest.json` and fetched by `npm run fonts:fetch` — Regular and Bold, 9 MB across
194 `unicode-range` subsets. The splitting is the point: the family is megabytes, but a
browser downloads only the subsets whose ranges a document actually sets, so this page costs
about six of them and an English one costs two. That is what makes a CJK face affordable
here at all, and it is the difference from Claude's 25 MB Noto Serif SC, which is skipped —
that one is a single file every visitor would pay for in full.

### Vendored

The rest are vendored into `public/themes/<pack>/`, preserving each repo's directory layout
so their internal `@import` and `url()` references still resolve. `themes.manifest.json`
lists what to fetch; `scripts/fetch-themes.mjs` downloads it, then scans every stylesheet
for local references that weren't brought along and fails if any are missing — that check
is how a missing webfont surfaces at fetch time instead of as a silent visual regression.

**Adding or removing one is a manifest edit.** `themes:fetch` reconciles `public/themes/`
against `themes.manifest.json` rather than rebuilding it: packs already vendored at the
same revision are left alone, packs no longer listed are deleted, and only what actually
changed is downloaded. So dropping a pack costs one run and no network at all, and adding
one costs only that pack. `--force` re-downloads everything.

```sh
# remove: delete the pack's entry from themes.manifest.json, then
npm run themes:fetch
```

A pack counts as current when its directory exists and its manifest entry is byte-for-byte
what produced it — recorded per pack in `public/themes/index.json` — so changing a `ref`, a
`files` glob or a `skip` list re-fetches that pack and nothing else.

Currently vendored — 6 themes across 3 packs, 0.62 MB, plus our own 4:

| pack | themes | licence | author |
|---|---|---|---|
| [Kiwidown](https://github.com/ashawkey/kiwidown) — built in | 4 | MIT | ashawkey |
| [Claude](https://github.com/Tsumugii24/claude-typora-theme) | 2 | MIT | Tsumugii24 |
| [LightMind](https://github.com/SunMoonTrain/LightMindTheme) | 2 | MIT | SunMoonTrain |
| [LaTeX](https://github.com/Keldos-Li/typora-latex-theme) | 2 | **GPL-3.0** | Keldos-Li |

Only packs that actually grant redistribution are vendored. Typora's own built-in themes
and Academic carry no licence file — which means all rights reserved — so they are not
included. Full detail, including what the one copyleft pack implies, is in
[THIRD-PARTY.md](THIRD-PARTY.md).

The LaTeX theme ships only as a release archive (its repository holds SCSS and builds CSS
at release time), so the fetcher unpacks zips as well as reading repositories.

Fonts too large to vendor are skipped — Claude's 25 MB Noto Serif SC — and the
`@font-face` rules naming them are removed so they can't 404. The same
applies to `@import`s of files that don't exist upstream, such as Typora's `*.user.css`
override hooks.

## Layout

```
public/
  typora-base/       Typora's base.css + codemirror.css (vendored, unmodified)
  themes/            vendored theme packs + generated index.json
    kiwi/            Su 素, Qi 漆, 璃素, 璃漆 — ours, not vendored
  fonts/             LXGW WenKai, as unicode-range subsets
src/
  editor/            Milkdown, configured to emit Typora's DOM
    code-highlight/  Prism tokens relabelled with CodeMirror class names
    code-fence/      the fence node view, and its language field
    typora-inline/   ==highlight==, X^2^, H~2~O, :emoji:
    math/            $…$ and $$…$$ via KaTeX, loaded on demand
    diagram/         ```mermaid via Mermaid, loaded on demand
    md-meta.ts       reveal-on-focus syntax markers
    block-enter.ts   Enter on a ```lang or $$ line opens that block
  doc/               the open documents: open/save, dirty tracking, autosave, ?src=
    views.ts         what the editor keeps for each tab — undo history, scroll, selection
  theme/             cascade layers, theme swapping, compat + bridge shims
  app/               chrome — document bar, theme picker, toasts
  welcome/           welcome.md — the first-run document, and check:contract's input
test/
  shots/             screenshot output (gitignored)
doc/
  dom-contract.md    the DOM the editor must emit, and why
```

## Credits

`public/typora-base/` is vendored from
[typora/typora-theme-toolkit](https://github.com/typora/typora-theme-toolkit), which Typora published for theme authors. 
Theme packs remain under their own licences, listed above.
