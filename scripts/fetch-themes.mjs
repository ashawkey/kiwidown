// Vendors community Typora themes listed in themes.manifest.json into public/themes/.
//
// Themes are copied verbatim, preserving their repo-relative directory layout, so the
// relative @import and url() references inside them keep resolving. Nothing is rewritten.
//
// After downloading, every CSS file is scanned for references it makes to other local
// files; anything the manifest didn't bring along is reported. That check is the point --
// it's how a missing font or sub-stylesheet shows up here instead of as a silent visual
// regression noticed much later, in a screenshot.
//
// Output (including public/themes/index.json) is committed, so the site builds offline.
//
// The manifest is the source of truth and this reconciles against it, rather than wiping
// public/themes/ and starting again: packs already vendored at the same revision are left
// alone, packs no longer listed are deleted, and only what actually changed is downloaded.
// So *removing* a theme is a manifest edit and a run that touches the network zero times,
// and adding one costs only that pack.
//
//   npm run themes:fetch              # reconcile
//   npm run themes:fetch -- --force   # re-download everything anyway
//
// A pack is considered current when its directory exists and the manifest entry that
// produced it is byte-for-byte what it was last time -- recorded per pack in index.json, so
// changing a `ref`, a `files` glob or a `skip` list re-fetches that pack and nothing else.
//
// One pack is marked `"local": true`: Kiwidown's own built-in themes, which are source, not
// vendored material. They have no upstream to reconcile against, so they are never
// downloaded and never deleted -- but they are indexed and reference-checked exactly like
// the rest, which is what keeps a typo in one of our own url()s from reaching a screenshot.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, posix, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { unzipSync } from 'fflate'

import { configureNetwork } from './net.mjs'

configureNetwork()

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'themes')

/**
 * Local, non-data references a stylesheet makes: `@import "x"` and `url(x)`.
 *
 * Neither alternative may span a newline. Without that guard a stray `@import` in a
 * comment swallows everything up to the next semicolon, which can be most of a file.
 */
const REF_RE = /@import\s+(?:url\(\s*)?['"]?([^)'";\n]+)['"]?|url\(\s*['"]?([^)'"\n]+?)['"]?\s*\)/g

/**
 * Is this reference a file we would have to vendor?
 *
 * Excludes data URIs, absolute URLs, and `url(#id)` -- the last of which points at an SVG
 * fragment in the same document, not at a file. Themes that restyle Mermaid reach for
 * `url(#arrowhead)` and similar; without this they get reported as missing assets on
 * every run.
 */
function isLocalAsset(raw) {
  return Boolean(raw) && !/^(data:|https?:|\/\/|#)/.test(raw)
}

/** Every local file a stylesheet references, resolved relative to the stylesheet. */
function localRefs(css, cssPath) {
  const refs = []
  for (const m of css.matchAll(REF_RE)) {
    const raw = (m[1] ?? m[2] ?? '').trim()
    if (!isLocalAsset(raw)) continue
    refs.push(posix.normalize(posix.join(posix.dirname(cssPath), raw.replace(/[?#].*$/, ''))))
  }
  return refs
}

async function githubTree(repo, ref) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`
  const res = await fetch(url, { headers: { 'User-Agent': 'kiwidown' } })
  if (!res.ok) throw new Error(`tree ${repo}@${ref}: ${res.status} ${res.statusText}`)
  const { tree } = await res.json()
  return tree.filter((n) => n.type === 'blob').map((n) => n.path)
}

/** Resolve manifest `files` patterns (exact paths, or a trailing-`*` glob) against the tree. */
function resolveFiles(patterns, skip, tree) {
  const skipSet = new Set(skip ?? [])
  const picked = new Set()
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
      const hits = tree.filter((p) => re.test(p))
      if (hits.length === 0) console.warn(`    ! glob matched nothing: ${pattern}`)
      hits.forEach((p) => picked.add(p))
    } else if (tree.includes(pattern)) {
      picked.add(pattern)
    } else {
      console.warn(`    ! not in repo: ${pattern}`)
    }
  }
  return [...picked].filter((p) => !skipSet.has(p)).sort()
}

/**
 * Fetch one file, retrying transient network failures.
 *
 * This pulls a few dozen files per run, and the script clears the output directory before
 * it starts -- so a single dropped connection would otherwise leave the vendored themes
 * half-deleted. HTTP errors are not retried: those are wrong paths in the manifest, and
 * repeating them just delays the report.
 *
 * Retries are insurance, not a substitute for ./net.mjs. If every download is retrying,
 * the proxy isn't configured and the requests are going nowhere useful.
 */
async function download(repo, ref, path, attempts = 8) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} - ${url}`), { fatal: true })
      return Buffer.from(await res.arrayBuffer())
    } catch (error) {
      if (error?.fatal || attempt >= attempts) throw error
      console.warn(`    ... retrying ${path} (${error.cause?.code ?? error.message})`)
      // Backs off further each time: these failures come in bursts, and the multi-hundred
      // kilobyte font files are the ones that get cut off.
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt))
    }
  }
}

/**
 * Fetch and unpack a zip pack.
 *
 * Some themes are only published as archives because their repositories contain sources
 * but no built CSS. The archive's internal layout is preserved for the same reason a
 * repo's is: the stylesheets reference their fonts relatively.
 *
 * Returns a path → bytes map, minus the debris macOS leaves in zips.
 */
async function downloadZip(url, attempts = 8) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'kiwidown' } })
      if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} — ${url}`), { fatal: true })
      const entries = unzipSync(new Uint8Array(await res.arrayBuffer()))
      const files = new Map()
      for (const [path, data] of Object.entries(entries)) {
        if (data.length === 0) continue // directory entry
        if (path.startsWith('__MACOSX/') || posix.basename(path) === '.DS_Store') continue
        files.set(path, Buffer.from(data))
      }
      return files
    } catch (error) {
      if (error?.fatal || attempt >= attempts) throw error
      console.warn(`    … retrying archive (${error.cause?.code ?? error.message})`)
      // Backs off further each time: these failures come in bursts, and the multi-hundred
      // kilobyte font files are the ones that get cut off.
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt))
    }
  }
}

/**
 * Drop `@font-face` blocks whose `src` points at an asset we aren't vendoring.
 *
 * Naming a font we don't ship isn't harmless: every page load requests a file that isn't
 * there, and on a single-page site that 404 is answered with index.html, which the browser
 * then tries to parse as a font -- `OTS parsing error: invalid sfntVersion: 1008821359`,
 * which is `<!DO` read as a number.
 *
 * This covers both fonts we deliberately skipped for size — Claude's 25 MB Noto Serif SC,
 * see the `skip` list in themes.manifest.json — and fonts an upstream project references
 * but never committed.
 *
 * The one place a vendored stylesheet is modified, and only ever by removing a rule that
 * could not have worked. The font falls back to the next in its stack, as it would anyway.
 */
function stripDeadFontFaces(css, cssPath, vendored) {
  const removed = []
  const out = css.replace(/@font-face\s*\{[^}]*\}/g, (block) => {
    for (const resolved of localRefs(block, cssPath)) {
      if (!vendored.has(resolved)) {
        removed.push(resolved)
        return `/* @font-face for ${posix.basename(resolved)} removed: asset not vendored */`
      }
    }
    return block
  })
  return { css: out, removed }
}

/**
 * Drop `@import` rules pointing at stylesheets we aren't vendoring.
 *
 * Same failure as a dead `@font-face`, and for the same reason: a request that 404s into
 * index.html. Themes commonly `@import` a `<theme>.user.css` for the reader's own
 * overrides -- a Typora convention where the file is expected not to exist -- so these are
 * optional by design and dropping them changes nothing.
 */
function stripDeadImports(css, cssPath, vendored) {
  const removed = []
  const out = css.replace(/@import\s+(?:url\()?\s*['"]?([^)'";]+)['"]?\s*\)?\s*;/g, (rule, raw) => {
    const ref = raw.trim()
    if (!isLocalAsset(ref)) return rule
    const resolved = posix.normalize(posix.join(posix.dirname(cssPath), ref.replace(/[?#].*$/, '')))
    if (vendored.has(resolved)) return rule
    removed.push(resolved)
    // Deliberately does not contain the word "@import": the reference scanner runs over
    // this file afterwards and would match its own comment.
    return `/* dropped ${posix.basename(resolved)}: stylesheet not vendored */`
  })
  return { css: out, removed }
}

/**
 * Report local references a pack's stylesheets make that nothing answers.
 *
 * By the time this runs, dead `@font-face` rules have already been removed -- so anything
 * still reported is a stylesheet, image or font referenced from somewhere the stripper
 * doesn't reach, and means the manifest needs another entry.
 *
 * A reference that climbs out of the pack is resolved against the served `public/` tree
 * instead, because that is what the browser will do: theme CSS is attached with
 * `@import url(...)`, so its relative URLs resolve from the theme file's own location. Our
 * built-in themes use this to reach a shared webfont in public/fonts/ rather than carrying
 * their own copy. Anything landing outside public/ is unreachable at runtime and is
 * reported as missing however real the file is on disk.
 */
function checkReferences(files, contents, slug) {
  const have = new Set(files)
  const packDir = join(OUT_DIR, slug)
  const publicDir = join(ROOT, 'public')
  const missing = new Set()

  const servedElsewhere = (ref) => {
    const abs = join(packDir, ref)
    return abs.startsWith(publicDir + sep) && existsSync(abs)
  }

  for (const [path, buf] of contents) {
    if (!path.endsWith('.css')) continue
    for (const resolved of localRefs(buf.toString('utf8'), path)) {
      if (have.has(resolved) || servedElsewhere(resolved)) continue
      missing.add(`${resolved}  (from ${path})`)
    }
  }
  for (const m of missing) console.warn(`    ! MISSING reference: ${m}`)
  return missing.size
}

/** Identity of a pack as the manifest describes it. Any change re-fetches that pack. */
function fingerprint(pack) {
  return createHash('sha256').update(JSON.stringify(pack)).digest('hex').slice(0, 16)
}

/** Everything already under `public/themes/<slug>/`, as pack-relative paths. */
async function vendoredFiles(slug) {
  const { readdir } = await import('node:fs/promises')
  const base = join(OUT_DIR, slug)
  const out = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else out.push(posix.normalize(path.slice(base.length + 1).split(/[\\/]/).join('/')))
    }
  }
  await walk(base)
  return out.sort()
}

/** Download a pack into `public/themes/<slug>/`. Returns its vendored paths and bytes. */
async function fetchPack(pack) {
  // Two kinds of source, one shape afterwards: a list of paths and a way to read each.
  // Zip packs are fully in memory already; repo packs fetch each file on demand.
  let listing
  let read
  if (pack.zip) {
    const entries = await downloadZip(pack.zip)
    listing = [...entries.keys()]
    read = async (path) => entries.get(path)
  } else {
    listing = await githubTree(pack.repo, pack.ref)
    read = (path) => download(pack.repo, pack.ref, path)
  }

  const files = resolveFiles(pack.files, pack.skip, listing)
  const vendored = new Set(files)
  for (const s of pack.skip ?? []) console.log(`    - skipped ${s}`)

  // Replaced wholesale, so a file dropped from `files` doesn't linger from a previous run.
  await rm(join(OUT_DIR, pack.slug), { recursive: true, force: true })

  /** @type {Array<[string, Buffer]>} */
  const contents = []
  for (const path of files) {
    let buf = await read(path)
    if (path.endsWith('.css')) {
      const faces = stripDeadFontFaces(buf.toString('utf8'), path, vendored)
      const imports = stripDeadImports(faces.css, path, vendored)
      for (const r of faces.removed) console.log(`    - dropped @font-face -> ${posix.basename(r)} in ${path}`)
      for (const r of imports.removed) console.log(`    - dropped @import -> ${posix.basename(r)} in ${path}`)
      if (faces.removed.length || imports.removed.length) buf = Buffer.from(imports.css, 'utf8')
    }
    const dest = join(OUT_DIR, pack.slug, path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buf)
    contents.push([path, buf])
  }
  return { files, contents }
}

async function main() {
  const force = process.argv.includes('--force')
  const manifest = JSON.parse(await readFile(join(ROOT, 'themes.manifest.json'), 'utf8'))
  await mkdir(OUT_DIR, { recursive: true })

  // What the last run left behind, so this one can tell what still needs doing.
  let previous = { packs: {} }
  try {
    previous = JSON.parse(await readFile(join(OUT_DIR, 'index.json'), 'utf8'))
  } catch {
    // No index yet, or an unreadable one: treat everything as new.
  }

  // Packs the manifest no longer lists. Removing a theme is exactly this and nothing else.
  // Local packs are listed too, so this never reaches them; deleting one would mean
  // deleting source.
  const wanted = new Set(manifest.packs.map((p) => p.slug))
  for (const slug of Object.keys(previous.packs ?? {})) {
    if (wanted.has(slug)) continue
    await rm(join(OUT_DIR, slug), { recursive: true, force: true })
    console.log(`- removed ${slug} (no longer in the manifest)`)
  }

  const index = []
  const packs = {}
  let totalBytes = 0
  let totalMissing = 0
  let fetched = 0

  for (const pack of manifest.packs) {
    const origin = pack.local ? 'built in' : pack.zip ? pack.zip.split('/').slice(-1)[0] : `${pack.repo}@${pack.ref}`
    const stamp = fingerprint(pack)
    // A local pack is source: it is always already here, and re-fetching it would mean
    // downloading over the top of something nobody published.
    const current =
      pack.local || (!force && previous.packs?.[pack.slug]?.fingerprint === stamp && existsSync(join(OUT_DIR, pack.slug)))

    if (pack.local && !existsSync(join(OUT_DIR, pack.slug))) {
      throw new Error(`local pack "${pack.slug}" is missing from public/themes/ — it is source, not a download`)
    }

    let files
    let contents
    if (current) {
      // Unchanged: read what's on disk rather than the network, so the reference check
      // below still runs and a hand-edited vendored file is still caught.
      files = await vendoredFiles(pack.slug)
      contents = await Promise.all(
        files.map(async (path) => [path, await readFile(join(OUT_DIR, pack.slug, path))])
      )
      console.log(`\n${pack.name}  (${origin}, ${pack.license})${pack.local ? '' : '  — vendored, skipping'}`)
    } else {
      console.log(`\n${pack.name}  (${origin}, ${pack.license})`)
      ;({ files, contents } = await fetchPack(pack))
      fetched++
    }

    const bytes = contents.reduce((n, [, b]) => n + b.length, 0)
    totalBytes += bytes
    console.log(`    ${files.length} files, ${(bytes / 1024).toFixed(0)} KB`)

    totalMissing += checkReferences(files, contents, pack.slug)
    packs[pack.slug] = { fingerprint: stamp, files: files.length }

    for (const theme of pack.themes) {
      if (!files.includes(theme.css)) {
        console.warn(`    ! theme "${theme.slug}" points at un-vendored ${theme.css}`)
        continue
      }
      index.push({
        id: `${pack.slug}/${theme.slug}`,
        name: theme.name,
        pack: pack.name,
        dark: Boolean(theme.dark),
        href: `${pack.slug}/${theme.css}`,
        license: pack.license,
        author: pack.author,
        // Zip packs name their project explicitly; repo packs derive it.
        source: pack.source ?? `https://github.com/${pack.repo}`,
      })
    }
  }

  // Built-in packs first, then the vendored ones alphabetically. The picker groups by pack
  // in index order, and the theme the editor opens with should head the list rather than be
  // filed alphabetically among the third-party packs.
  const builtin = new Set(manifest.packs.filter((p) => p.local).map((p) => p.name))
  const rank = (t) => (builtin.has(t.pack) ? 0 : 1)
  index.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    // Within a pack we wrote, the manifest's order is the intended one — light before dark,
    // default first — and Array#sort is stable, so returning 0 keeps it. Vendored packs have
    // no order we know of, so they get an alphabetical one.
    if (rank(a) === 0) return 0
    return a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name)
  })
  await writeFile(
    join(OUT_DIR, 'index.json'),
    `${JSON.stringify({ generated: new Date().toISOString(), packs, themes: index }, null, 2)}\n`,
    'utf8'
  )

  const how = fetched === 0 ? 'nothing to download' : `${fetched} pack(s) downloaded`
  console.log(`\n${index.length} themes, ${(totalBytes / 1024 / 1024).toFixed(2)} MB -> public/themes/  (${how})`)
  if (totalMissing > 0) {
    console.error(`\n${totalMissing} unresolved reference(s) - add them to the manifest's files or skip list.`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
