# Third-party material

Kiwidown's own source is MIT (see [LICENSE](LICENSE)). This file covers everything else
that ships in the repository or in a build.

## Our own themes — `public/themes/kiwi/`

Su 素, Qi 漆, Ye 叶, Glassy Su 璃素, Glassy Qi 璃漆 and Glassy Ye 璃叶 are written here,
not ported, and are MIT along with the rest of Kiwidown's source. They are the one pack
under `public/themes/` that
is not third-party material; the manifest marks them `"local": true` so `themes:fetch` never
treats them as a download.

The glazed trio follow Apple's **Liquid Glass** design language. No Apple code, asset or
typeface is used or redistributed — the material is rebuilt from CSS primitives
(`backdrop-filter`, gradients, inset highlights), while each theme retains the typography
of its paper counterpart. "Liquid Glass" is Apple's name for the language and is referred
to only descriptively; the themes are named 璃素, 璃漆 and 璃叶.

## Themes — `public/themes/`

Vendored verbatim by `npm run themes:fetch`, each with its own licence file alongside, and
credited in the UI next to the theme picker. The only modification is mechanical: dead
`@font-face` and `@import` rules — those naming files we don't ship — are removed at fetch
time, because a missing file 404s into `index.html` and the browser then tries to parse
HTML as a font.

| pack | themes | licence | source |
|---|---|---|---|
| Claude | 2 | MIT | [Tsumugii24/claude-typora-theme](https://github.com/Tsumugii24/claude-typora-theme) |
| LightMind | 2 | MIT | [SunMoonTrain/LightMindTheme](https://github.com/SunMoonTrain/LightMindTheme) |

### Deliberately not vendored

Typora's own themes — the built-in set in
[typora/typora-default-themes](https://github.com/typora/typora-default-themes) and Academic
from [typora/typora-theme-gallery](https://github.com/typora/typora-theme-gallery) — carry
no licence file. No licence means all rights reserved, so there is no grant to redistribute
them inside another project, however freely Typora publishes them to its own users.

## Webfonts — `public/fonts/`

Vendored by `npm run fonts:fetch` from the manifest in `fonts.manifest.json`. Unlike the
fonts inside theme packs, these are asked for by our own themes rather than brought along by
somebody else's.

| family | licence | source | used by |
|---|---|---|---|
| [LXGW WenKai 霞鹜文楷](https://github.com/lxgw/LxgwWenKai) | [SIL OFL-1.1](https://openfontlicense.org/) | [`lxgw-wenkai-webfont`](https://www.npmjs.com/package/lxgw-wenkai-webfont) | Su 素, Qi 漆 |

OFL-1.1 permits redistribution — including bundled with software, and including as
webfonts — provided the licence travels with the font and the font is not sold on its own.
`OFL.txt` and `LICENSE` are vendored into `public/fonts/lxgw-wenkai/` for that reason. The
one restriction that would bite is the Reserved Font Name clause: a *modified* copy may not
keep the name "LXGW WenKai". Nothing here modifies the font — the woff2 subsets are taken as
the upstream package publishes them, and only the `@font-face` rules are concatenated into a
single stylesheet.

Regular (400) and Bold (700) are vendored. The Light cut and the whole Mono family are
published in the same package and deliberately left out, at roughly 4.4 MB each.

## Typora base stylesheets — `public/typora-base/`

`base.css` and `codemirror.css`, vendored from
[typora/typora-theme-toolkit](https://github.com/typora/typora-theme-toolkit) by
`npm run base:fetch`.

**This repository has the same problem as the themes above: the toolkit carries no licence
file.** These are not themes but the foundation every community theme is written against —
the `#write` box model, task-list layout, footnote defaults — so removing them means
reimplementing an equivalent base layer rather than simply dropping a feature. That work is
outstanding.


## Runtime dependencies

Installed from npm, not vendored. The tree is 261 MIT, 35 ISC, and a handful of BSD and
Apache-2.0 packages, with nothing copyleft. The notable ones:

| package | licence | used for |
|---|---|---|
| [@milkdown/kit](https://github.com/Milkdown/milkdown) | MIT | the editor (ProseMirror + remark) |
| [CodeMirror 6](https://github.com/codemirror) (`@codemirror/*`, `@lezer/*`) | MIT | source mode: highlighting, folding, find |
| [refractor](https://github.com/wooorm/refractor) / Prism | MIT | code fence tokenising |
| [KaTeX](https://github.com/KaTeX/KaTeX) | MIT | `$math$` |
| [Mermaid](https://github.com/mermaid-js/mermaid) | MIT | ` ```mermaid ` diagrams |
| [Lucide](https://github.com/lucide-icons/lucide) | ISC | toolbar icons |
| [remark-gemoji](https://github.com/remarkjs/remark-gemoji), [remark-math](https://github.com/remarkjs/remark-math), [remark-frontmatter](https://github.com/remarkjs/remark-frontmatter) | MIT | Markdown extensions |
| [Vite](https://github.com/vitejs/vite) | MIT | build |
| [Playwright](https://github.com/microsoft/playwright) | Apache-2.0 | checks (dev only) |

Webfonts bundled inside theme packs keep their own licences — SIL OFL, GUST e-foundry and
similar — and their notices travel with them in the pack directories. The one font vendored
outside a pack is covered above.
