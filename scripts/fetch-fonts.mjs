// Vendors the webfonts listed in fonts.manifest.json into public/fonts/.
//
// Only our own built-in themes use this. Community theme packs bring their own fonts along
// inside public/themes/<pack>/, because those stylesheets reference them relatively and
// rewriting the reference would mean modifying a vendored theme.
//
// Each family arrives as a set of npm-published stylesheets that split one font across many
// `unicode-range` subsets -- one @font-face per subset, each naming its own woff2. That
// split is what makes a CJK face affordable: the family is megabytes, but a browser fetches
// only the subsets whose ranges the page actually uses, so a document in English costs a
// couple of them and one in Chinese costs the handful its characters fall in.
//
// The chosen stylesheets are concatenated into <slug>.css and every woff2 they reference is
// vendored beside it, so the result is self-contained -- which is the whole point, since the
// site is meant to work offline and from disk.
//
// Output is committed, like public/themes/ and public/typora-base/.
//
//   npm run fonts:fetch              # reconcile
//   npm run fonts:fetch -- --force   # re-download everything anyway
//
// A family counts as current when its directory exists and the manifest entry that produced
// it is byte-for-byte what it was last time -- recorded per family in index.json, so
// changing a version or adding a weight re-fetches that family and nothing else.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { configureNetwork } from './net.mjs'

configureNetwork()

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'fonts')

/** How many files are in flight at once. The chunks are small and there are a lot of them. */
const CONCURRENCY = 8

/** Local, non-data `url()` references a stylesheet makes. */
const URL_RE = /url\(\s*['"]?([^)'"\n]+?)['"]?\s*\)/g

function isLocalAsset(raw) {
  return Boolean(raw) && !/^(data:|https?:|\/\/|#)/.test(raw)
}

/** Identity of a family as the manifest describes it. Any change re-fetches it. */
function fingerprint(family) {
  return createHash('sha256').update(JSON.stringify(family)).digest('hex').slice(0, 16)
}

/**
 * Fetch one file from jsDelivr, retrying transient network failures.
 *
 * A family is a couple of hundred requests, so a single dropped connection would otherwise
 * abandon the run half-written. HTTP errors are not retried: those mean the manifest names
 * something that isn't published, and repeating the request just delays saying so.
 *
 * Retries are insurance, not a substitute for ./net.mjs. If every download is retrying, the
 * proxy isn't configured and the requests are going nowhere useful.
 */
async function download(pkg, version, path, attempts = 8) {
  const url = `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${path}`
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'kiwidown' } })
      if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} — ${url}`), { fatal: true })
      return Buffer.from(await res.arrayBuffer())
    } catch (error) {
      if (error?.fatal || attempt >= attempts) throw error
      console.warn(`    … retrying ${path} (${error.cause?.code ?? error.message})`)
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    }
  }
}

/** Run `task` over `items`, a few at a time, preserving order. */
async function mapPool(items, limit, task) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await task(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Fetch one family into `public/fonts/<slug>/`.
 *
 * The stylesheets are concatenated rather than kept separate so a theme needs a single
 * @import. Their `/* … *\/` banner comments are dropped -- one per subset, several hundred
 * across a family, and they say nothing the unicode-range doesn't.
 */
async function fetchFamily(family) {
  const { package: pkg, version, slug } = family

  const sheets = await mapPool(family.sheets, CONCURRENCY, async (name) => ({
    name,
    css: (await download(pkg, version, name)).toString('utf8'),
  }))

  // Every woff2 the sheets ask for, resolved relative to the sheet (they live in ./files/).
  const assets = new Set()
  for (const { name, css } of sheets) {
    for (const m of css.matchAll(URL_RE)) {
      const raw = m[1].trim()
      if (!isLocalAsset(raw)) continue
      assets.add(posix.normalize(posix.join(posix.dirname(name), raw.replace(/[?#].*$/, ''))))
    }
  }

  // Replaced wholesale, so a subset dropped upstream doesn't linger from a previous run.
  await rm(join(OUT_DIR, slug), { recursive: true, force: true })

  const paths = [...assets].sort()
  let bytes = 0
  await mapPool(paths, CONCURRENCY, async (path) => {
    const buf = await download(pkg, version, path)
    const dest = join(OUT_DIR, slug, path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buf)
    bytes += buf.length
  })

  const header = [
    `/* ${family.name} ${version} — ${family.license}`,
    ` * ${family.source}`,
    ` * Vendored by scripts/fetch-fonts.mjs from ${pkg}. Do not edit; see fonts.manifest.json.`,
    ` */`,
    '',
  ].join('\n')
  const body = sheets
    .map(({ css }) => css.replace(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, '').replace(/\n{2,}/g, '\n').trim())
    .join('\n\n')
  const stylesheet = `${header}${body}\n`
  await writeFile(join(OUT_DIR, slug, `${slug}.css`), stylesheet, 'utf8')
  bytes += Buffer.byteLength(stylesheet)

  // Licences and notices travel with the font.
  for (const doc of family.docs ?? []) {
    const buf = await download(pkg, version, doc)
    await writeFile(join(OUT_DIR, slug, doc), buf)
    bytes += buf.length
  }

  return { assets: paths, bytes }
}

/** Everything already under `public/fonts/<slug>/`, as family-relative paths. */
async function vendoredFiles(slug) {
  const { readdir } = await import('node:fs/promises')
  const base = join(OUT_DIR, slug)
  const out = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else out.push(path.slice(base.length + 1).split(/[\\/]/).join('/'))
    }
  }
  await walk(base)
  return out.sort()
}

/**
 * Report woff2 files `<slug>.css` names but that aren't on disk.
 *
 * The same check fetch-themes.mjs runs, and for the same reason: a missing font is answered
 * on a single-page site with index.html, which the browser then tries to parse as a font.
 * Better to hear about it here than to find it in a screenshot.
 */
async function checkReferences(slug, files) {
  const have = new Set(files)
  const css = await readFile(join(OUT_DIR, slug, `${slug}.css`), 'utf8')
  const missing = new Set()
  for (const m of css.matchAll(URL_RE)) {
    const raw = m[1].trim()
    if (!isLocalAsset(raw)) continue
    const resolved = posix.normalize(raw.replace(/^\.\//, '').replace(/[?#].*$/, ''))
    if (!have.has(resolved)) missing.add(resolved)
  }
  for (const m of missing) console.warn(`    ! MISSING reference: ${m}`)
  return missing.size
}

async function main() {
  const force = process.argv.includes('--force')
  const manifest = JSON.parse(await readFile(join(ROOT, 'fonts.manifest.json'), 'utf8'))
  await mkdir(OUT_DIR, { recursive: true })

  let previous = { families: {} }
  try {
    previous = JSON.parse(await readFile(join(OUT_DIR, 'index.json'), 'utf8'))
  } catch {
    // No index yet, or an unreadable one: treat everything as new.
  }

  // Families the manifest no longer lists. Removing a font is exactly this and nothing else.
  const wanted = new Set(manifest.families.map((f) => f.slug))
  for (const slug of Object.keys(previous.families ?? {})) {
    if (wanted.has(slug)) continue
    await rm(join(OUT_DIR, slug), { recursive: true, force: true })
    console.log(`- removed ${slug} (no longer in the manifest)`)
  }

  const families = {}
  let totalBytes = 0
  let totalMissing = 0
  let fetched = 0

  for (const family of manifest.families) {
    const stamp = fingerprint(family)
    const current =
      !force && previous.families?.[family.slug]?.fingerprint === stamp && existsSync(join(OUT_DIR, family.slug))

    let files
    let bytes
    if (current) {
      console.log(`\n${family.name}  (${family.package}@${family.version}, ${family.license})  — vendored, skipping`)
      files = await vendoredFiles(family.slug)
      bytes = (
        await Promise.all(files.map(async (p) => (await readFile(join(OUT_DIR, family.slug, p))).length))
      ).reduce((a, b) => a + b, 0)
    } else {
      console.log(`\n${family.name}  (${family.package}@${family.version}, ${family.license})`)
      for (const s of family.skipped ?? []) console.log(`    - skipped ${s}`)
      ;({ bytes } = await fetchFamily(family))
      files = await vendoredFiles(family.slug)
      fetched++
    }

    totalBytes += bytes
    console.log(`    ${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`)
    totalMissing += await checkReferences(family.slug, files)

    families[family.slug] = {
      fingerprint: stamp,
      files: files.length,
      css: `${family.slug}/${family.slug}.css`,
      name: family.name,
      license: family.license,
      author: family.author,
      source: family.source,
    }
  }

  await writeFile(
    join(OUT_DIR, 'index.json'),
    `${JSON.stringify({ generated: new Date().toISOString(), families }, null, 2)}\n`,
    'utf8'
  )

  const how = fetched === 0 ? 'nothing to download' : `${fetched} famil${fetched === 1 ? 'y' : 'ies'} downloaded`
  const n = Object.keys(families).length
  console.log(`\n${n} famil${n === 1 ? 'y' : 'ies'}, ${(totalBytes / 1024 / 1024).toFixed(2)} MB -> public/fonts/  (${how})`)
  if (totalMissing > 0) {
    console.error(`\n${totalMissing} unresolved reference(s).`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
