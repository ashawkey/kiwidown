import { $nodeAttr, $nodeSchema, $remark } from '@milkdown/kit/utils'
import remarkFrontmatter from 'remark-frontmatter'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'

/*
 * YAML front matter, rendered the way Typora does.
 *
 * Without this, remark reads the closing `---` as a setext underline and promotes the
 * metadata into an `<h2>` — the document doesn't merely lose a feature, it renders wrong,
 * which is why the reference document can only be opened verbatim with this in place.
 *
 * Typora renders the block as `<pre class="md-meta-block md-end-block">` holding the raw
 * YAML, which nearly every vendored theme picks up through `.md-meta-block`.
 */

export const frontMatterAttr = $nodeAttr('front_matter')

export const frontMatterSchema = $nodeSchema('front_matter', (ctx) => ({
  content: 'text*',
  group: 'block',
  marks: '',
  defining: true,
  code: true,
  // Only meaningful as the first block; ProseMirror can't express that in the schema, but
  // remark-frontmatter only ever produces one and only at the top.
  atom: false,
  parseDOM: [
    {
      tag: 'pre.md-meta-block',
      preserveWhitespace: 'full',
    },
  ],
  toDOM: () => [
    'pre',
    { ...ctx.get(frontMatterAttr.key)({} as never), class: 'md-meta-block md-end-block' },
    0,
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'yaml',
    runner: (state, node, type) => {
      state.openNode(type)
      const value = node.value as string | undefined
      if (value) state.addText(value)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'front_matter',
    runner: (state, node) => {
      state.addNode('yaml', undefined, node.content.firstChild?.text ?? '')
    },
  },
}))

// 'yaml' is remark-frontmatter's default; naming it explicitly documents which of the
// several front-matter dialects is enabled.
const remarkFrontMatterPlugin = $remark('frontMatter', () => remarkFrontmatter, ['yaml'])

export const frontMatter: MilkdownPlugin[] = [
  remarkFrontMatterPlugin,
  frontMatterAttr,
  frontMatterSchema,
].flat()
