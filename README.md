# 🥝 Kiwidown

**A polished WYSIWYG Markdown editor that runs entirely in your browser.**

Write like you would in a rich-text editor while keeping a clean, portable `.md` file. Kiwidown supports real Typora themes, multiple documents, math, diagrams, and direct file access—without an account or backend.

### [Try Kiwidown → md.kiui.moe](https://md.kiui.moe)

## Features

- **WYSIWYG editing** — Markdown markers stay out of the way until you place the cursor inside them.
- **Table editing** — Point at a table to resize it, align a column, or delete it.
- **Beautiful themes** — Choose from Kiwidown's built-in designs and community Typora themes.
- **Multiple tabs** — Keep several documents open without losing each document's selection, scroll position, or undo history.
- **Work recovery** — Unsaved documents are backed up locally and can be restored after a crash or accidental close.
- **Private by design** — Static website that can run without network access. There is no account, upload, or server-side document storage.

## Start writing

Open the [live editor](https://md.kiui.moe) and edit the welcome document, or press `Ctrl+O` to open an existing Markdown file. Use the toolbar to create documents, switch themes, and tune the page to your liking.

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Open a Markdown file |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save as |
| `Ctrl+Alt+N` | New document |
| `Ctrl+Alt+←` / `Ctrl+Alt+→` | Switch documents |
| `Ctrl+Alt+W` | Close the current document |

To create a code or math block, type `` ```lang `` or `$$` on an empty line and press Enter.

> Raw inline HTML is displayed as text rather than executed, so Markdown loaded from external URLs cannot inject page content.

## Run locally

Kiwidown is a static Vite application. Node.js 20 or newer is recommended.

```sh
npm ci
npm run dev
```

Open <http://localhost:5173>. To create a production build:

```sh
npm run build
```

All required themes, fonts, and Typora base styles are included in the repository.

## Acknowledgments

- [Typora DOM compatibility contract](doc/dom-contract.md)
- [Third-party themes and licenses](THIRD-PARTY.md)

Kiwidown is built with TypeScript, Milkdown/ProseMirror, remark, KaTeX, and Mermaid. Typora base styles and community theme packs remain under their respective licenses.
