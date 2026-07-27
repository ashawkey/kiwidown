import { defineConfig } from 'vite'

// Relative base so the built site works at any path — root domain, a GitHub Pages
// project subpath (/kiwidown/), or opened from disk — with no rebuild.
// Runtime URLs are built with `new URL(path, document.baseURI)`, which honours it.
export default defineConfig({
  base: './',
  resolve: {
    // Mermaid depends on KaTeX too. Without this they resolve to separate copies and both
    // end up in the output — still lazy, but 260 kB of duplicate.
    dedupe: ['katex'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    // Raised because the only chunks over the default are Mermaid's and KaTeX's, and both
    // are dynamically imported — nothing fetches them until a document actually contains a
    // diagram or a formula. The eagerly loaded set is roughly 190 kB gzipped; if that
    // grows past this, the warning should fire.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Three chunks that change on completely different schedules: the editor engine
        // and the syntax grammars are large and near-static, while app code changes every
        // commit. Splitting them means a deploy only invalidates the small chunk, and the
        // browser fetches all three in parallel on a cold load.
        manualChunks: {
          editor: ['@milkdown/kit/core', '@milkdown/kit/preset/commonmark', '@milkdown/kit/preset/gfm'],
          grammars: ['refractor'],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
})
