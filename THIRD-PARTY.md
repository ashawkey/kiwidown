# Third-party material

Kiwidown's own source is MIT (see [LICENSE](LICENSE)). This file covers everything else
that ships in the repository or in a build.

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
| Notion | 5 | MIT | [adrian-fuertes/typora-notion-theme](https://github.com/adrian-fuertes/typora-notion-theme) |
| Vue | 2 | Apache-2.0 | [blinkfox/typora-vue-theme](https://github.com/blinkfox/typora-vue-theme) |
| LaTeX | 2 | **GPL-3.0** | [Keldos-Li/typora-latex-theme](https://github.com/Keldos-Li/typora-latex-theme) |

### The one that constrains redistribution

**LaTeX — GPL-3.0.** Themes are swappable data files: nothing links to them and no code
derives from them, so this reads as aggregation under GPL §5 rather than a combined work,
and it does not reach Kiwidown's MIT source. The vendored copies are modified (the rule
stripping above), so those copies remain GPL-3.0 and carry the licence.

### Deliberately not vendored

Typora's own themes — the built-in set in
[typora/typora-default-themes](https://github.com/typora/typora-default-themes) and Academic
from [typora/typora-theme-gallery](https://github.com/typora/typora-theme-gallery) — carry
no licence file. No licence means all rights reserved, so there is no grant to redistribute
them inside another project, however freely Typora publishes them to its own users.

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

Installed from npm, not vendored. The tree is 250 MIT, 34 ISC, and a handful of BSD and
Apache-2.0 packages, with nothing copyleft. The notable ones:

| package | licence | used for |
|---|---|---|
| [@milkdown/kit](https://github.com/Milkdown/milkdown) | MIT | the editor (ProseMirror + remark) |
| [refractor](https://github.com/wooorm/refractor) / Prism | MIT | code fence tokenising |
| [KaTeX](https://github.com/KaTeX/KaTeX) | MIT | `$math$` |
| [Mermaid](https://github.com/mermaid-js/mermaid) | MIT | ` ```mermaid ` diagrams |
| [Lucide](https://github.com/lucide-icons/lucide) | ISC | toolbar icons |
| [remark-gemoji](https://github.com/remarkjs/remark-gemoji), [remark-math](https://github.com/remarkjs/remark-math), [remark-frontmatter](https://github.com/remarkjs/remark-frontmatter) | MIT | Markdown extensions |
| [Vite](https://github.com/vitejs/vite) | MIT | build |
| [Playwright](https://github.com/microsoft/playwright) | Apache-2.0 | checks (dev only) |

Webfonts bundled inside theme packs keep their own licences — SIL OFL, GUST e-foundry and
similar — and their notices travel with them in the pack directories.
