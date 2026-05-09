# xtatic

A small static-site generator: MDX in, plain HTML out. The MDX is compiled and executed at build time, so the output is just HTML — no client-side runtime, no hydration.

## Install & run

```sh
npm install --save-dev xtatic
npx xtatic build [TOP_DIR]
```

`TOP_DIR` defaults to the current directory. By default, xtatic walks `TOP_DIR/pages/**/*.{md,mdx}` and writes to `TOP_DIR/site/`.

The first positional argument is a command. The available commands are:

- `build [top_dir]` — build the site (the default if no command is given).
- `watch [top_dir]` — build, then rebuild on every change under `top_dir`. Errors don't kill the watcher; fix the file and save again.
- `serve [top_dir]` — watch and serve the output over HTTP. Defaults to <http://localhost:3000/>; override the port with `XTATIC_PORT=…`.
- `browse [top_dir]` — same as `serve`, then open the root page in your default browser.
- `help` — print usage.

If you invoke `xtatic` with no arguments, it runs `build` against the current directory. To build a different directory, pass it as the second argument: `xtatic build path/to/site`.

To override the input or output location, add an `xtatic` section to `TOP_DIR/package.json`:

```json
{
  "xtatic": {
    "inputDir": "src/pages",
    "outputDir": "dist",
    "layoutsDir": "src/layouts"
  }
}
```

Relative paths in config are resolved against `TOP_DIR`, not the working directory; absolute paths are used as-is.

`OUTPUT_DIR` is wiped at the start of every build so that renames and deletions can't leave stale files behind. Don't point it at a directory that holds anything you want to keep, and don't hand-edit files inside it — anything you put there will be erased on the next run. As a guard against catastrophic misconfiguration, xtatic refuses to build if `outputDir` is `/`, equal to a source directory, or an ancestor of `topDir`/`inputDir`/`layoutsDir`.

## How input maps to output

`xtatic` walks `INPUT_DIR/**/*.{md,mdx}`. Each file becomes `OUTPUT_DIR/<path>/index.html`. The four forms below are **equivalent and mutually exclusive** — putting two of them in the same input tree is an error:

| Input                                | Output                            |
| ------------------------------------ | --------------------------------- |
| `INPUT_DIR/foo/bar.md`               | `OUTPUT_DIR/foo/bar/index.html`   |
| `INPUT_DIR/foo/bar.mdx`              | same                              |
| `INPUT_DIR/foo/bar/index.md`         | same                              |
| `INPUT_DIR/foo/bar/index.mdx`        | same                              |

`INPUT_DIR/index.md` (or `.mdx`) is the root and writes to `OUTPUT_DIR/index.html`.

## Pages

Markdown is rendered normally. JSX inside MDX is evaluated against xtatic's JSX runtime, which produces HTML strings directly — no React, no virtual DOM.

[`remark-smartypants`](https://github.com/silvenon/remark-smartypants) is enabled by default, so straight quotes/apostrophes/dashes/ellipses in prose become typographic ones. To disable it, set `xtatic.smartypants` to `false` in `package.json`; to override its options, set it to an options object (passed through to the plugin):

```json
{
  "xtatic": {
    "smartypants": { "dashes": false }
  }
}
```

Frontmatter and named exports become metadata on the compiled module:

```mdx
---
title: About
---
export const tags = ['general'];

# About me
```

After compilation, this module exposes `mm.title === 'About'`, `mm.tags === ['general']`, and a default render function.

Inside JSX expressions, a module's own properties are also accessible as bare identifiers — handy for templating against frontmatter and the synthesized `childPages` / `layout`:

```mdx
---
title: Index
---
# {title}

<ul>{childPages.map((c) => <li>{c.title}</li>)}</ul>
```

Identifiers shadowed by parameters or local declarations resolve normally; it's only otherwise-unbound identifiers that fall through to the module object.

## Layouts

A layout wraps another module's content. It's just an MDX module whose `default` render function reads the wrapped module from `props.children`:

```mdx
<!-- LAYOUTS_DIR/main.mdx -->
<html>
  <head><title>{props.children.title}</title></head>
  <body>{props.children}</body>
</html>
```

A module gets a layout in one of two ways:

1. **Explicit**: set `layout: <name>` in frontmatter (or as a named export). The string is treated as a path relative to `LAYOUTS_DIR` (default: `TOP_DIR/layouts`, configurable via `xtatic.layoutsDir` in `package.json`). The `.md`/`.mdx` suffix is optional; with no suffix `.mdx` is preferred. Subpaths work: `layout: posts/article`.
2. **Inherited via `defaultLayout`**: if `layout` isn't set, xtatic walks from the module up to the root looking for a `defaultLayout`, and uses the first one it finds. The walk starts at the module itself, so a module's own `defaultLayout` applies to it. Set `defaultLayout` on the root to give every page a default; set it on a subdirectory's `index.md` to override for that subtree.

Layouts loaded by name can themselves declare `layout:` (or `defaultLayout:`) for nesting. You can also set `layout` directly to a module object via `import`, bypassing the layoutsDir lookup.

## The module tree

After compilation, every page is a module object exposing:

- `default(props)` — render function returning `{html: string}`
- `childPages` — `Array` of child modules sorted by `name`
- `layout` — the page's layout module (inherited or explicitly set; may be `undefined`)
- `name` — the module's last path segment (set on every module that's a child of another; the root has no `name`)
- frontmatter keys + any named exports

`childPages` is a plain JavaScript array, so `mm.childPages.map(...)`, `.find(...)`, `.length`, and `for (const child of mm.childPages) { ... }` all work directly.

## Custom components

Any module can be used as a JSX tag. The runtime calls its `default(props)` and inlines the result.

## Imports

An MDX file can import other `.md`, `.mdx`, and `.js` files. Specs use file paths *with* extensions, either relative to the importing file or absolute-from-`TOP_DIR` (leading `/`):

```mdx
import About from './about.mdx';
import { greet } from './lib/util.js';
import Card from '/components/card.mdx';
```

Absolute imports are rooted at `TOP_DIR`, not `INPUT_DIR`, so shared components and helpers can live alongside (rather than inside) the pages tree.

**Default import asymmetry.** `import X from spec`:

- For `.md`/`.mdx`, `X` is the *whole module object* (same shape as a `childPages` entry). Use `X` as a JSX tag, read frontmatter as `X.title`, etc.
- For `.js`, `X` is the module's ESM `default` export — standard JS semantics.

Named (`import { a, b } from ...`) and namespace (`import * as X from ...`) imports work for both, with the obvious meaning.

**Cycles are allowed.** Two `.mdx` files can import each other. During compile, an importer may briefly see a partially-initialized module — but by the time anything renders, every module on the cycle is fully populated, so component references resolve correctly.

**`.js` files are evaluated by Node's normal `import()`**, so they can use npm packages, Node built-ins, and relative `.js` imports of their own. They cannot import `.md`/`.mdx` (Node doesn't know how to load those).

Imports with bare specifiers (`import x from 'react'`), unknown extensions, or paths that escape `INPUT_DIR` are not formally supported and may fail or behave unexpectedly.

## Builtins

A small set of helpers ship with xtatic. Like Node's `node:*` modules, they're exposed under an `xtatic:` scheme and must be imported explicitly:

```mdx
import {html, readfile} from 'xtatic:builtins';

{html('<!DOCTYPE html>')}

<pre>{readfile('./snippet.txt')}</pre>
```

Available named exports:

- `html(s)` — wrap a string so the JSX runtime emits it raw, without HTML-escaping. Useful for doctypes, inline SVG, or any time you've already got trusted markup.
- `readfile(spec)` — synchronously read a file as UTF-8 at build time. Specs starting with `/` resolve against `TOP_DIR`; everything else resolves against the importing file's directory. Throws a clear error if the file is missing.

Importing from `xtatic:builtins` works identically in `.md`, `.mdx`, and `.jsx` files. Names you don't import don't shadow anything, so you're free to define a local `html` or `readfile` of your own.

### `<Image>`

`xtatic:image` exports a build-time image component. It reads a source image, processes it with [sharp](https://sharp.pixelplumbing.com/), and emits an `<img>` tag whose `src` is either a `data:` URL (for small outputs) or a content-addressed file under `OUTPUT_DIR/_assets/`.

```mdx
import {Image} from 'xtatic:image';

<Image src="./hero.jpg" alt="Sunset over the bay" width={1200} />
```

`sharp` is an optional peer dep — install it with `npm install sharp` when you first use `<Image>`. The component is loaded lazily, so projects that don't use it don't pay the install cost.

**Props specific to `<Image>`:**

- `src` (required) — path to the source image. Same resolution rules as `readfile`: `/foo` is rooted at `TOP_DIR`, anything else is relative to the importing file.
- `alt` (required) — accessible text. Use `alt=""` for purely decorative images. A missing `alt` is a build error.
- `width`, `height` — pixel dimensions to resize to. If only one is given, aspect ratio is preserved. Sharp's `withoutEnlargement` is on, so a small source won't be upscaled.
- `format` — `'avif'` (default), `'webp'`, `'jpeg'`, `'png'`. SVG sources are passed through unchanged; specifying a format on an SVG is an error.
- `quality` — encoder quality (sharp's per-format defaults if unset).
- `fit` — sharp fit mode: `'cover' | 'contain' | 'fill' | 'inside' | 'outside'`. Default `'inside'`.
- `inlineThreshold` — bytes. Outputs at or below this size are inlined as `data:` URLs; outputs above it are written to `OUTPUT_DIR/_assets/<hash>.<ext>` and referenced by absolute URL. Defaults to **8192 bytes**, configurable project-wide via `package.json` `xtatic.imageInlineThreshold`.

**Behavior baked in by default:**

- EXIF rotation is auto-applied; all other metadata is stripped (privacy + bytes).
- Output `width` and `height` attributes are always emitted, computed from the *processed* image, so the browser doesn't reflow on load.
- Identical `(src, processing-options)` deduplicates to a single asset file across the whole site.

Any extra props (`className`, `loading`, `decoding`, `id`, `data-*`, etc.) pass through to the rendered `<img>`. `className` is rewritten to `class`. Asset URLs are absolute (`/_assets/…`), so the site is expected to be served from the root.

Single-output-per-call only for now — `<picture>`/`srcset` for responsive images is a planned follow-up. There's no build cache yet either, so sharp re-runs on every build.

### `<Style>`

`xtatic:style` exports a build-time stylesheet component. It reads a CSS file, rewrites any `url(...)` references to point at hashed copies of the referenced assets, and emits either a `<style>` block (for small CSS) or a `<link rel="stylesheet">` pointing at a content-addressed file under `OUTPUT_DIR/_assets/`.

```mdx
import {Style} from 'xtatic:style';

<Style src="/css/main.css" />
```

**Props:**

- `src` (required) — path to the source CSS file. Same resolution rules as `<Image>`: `/foo` is rooted at `TOP_DIR`, anything else is relative to the importing file.
- `inlineThreshold` — bytes. CSS at or below this size is emitted inline as `<style>...</style>`; above, it goes to `OUTPUT_DIR/_assets/<hash>.css` and the call site gets a `<link>` instead. Defaults to **2048 bytes**, configurable project-wide via `package.json` `xtatic.styleInlineThreshold`.

**`url()` rewriting.** Any `url(...)` token inside the CSS — `background-image`, `@font-face src`, `cursor`, etc. — is resolved relative to the source CSS file's directory (or against `TOP_DIR` for `/`-rooted paths), the referenced bytes are hashed, and the URL is rewritten to `/_assets/<hash>.<ext>`. URLs starting with `data:`, `http://`, `https://`, `//`, or `#` (SVG fragment refs like `clip-path: url(#mask)`) are passed through unchanged. Identical references across multiple CSS files share a single asset file.

Any extra props (`media`, `nonce`, `crossorigin`, `id`, `data-*`, etc.) pass through to the rendered `<style>` or `<link>`. `className` is rewritten to `class`.

**Caveats:** `@import "..."` (the bare-string form) is not rewritten — only `url(...)` tokens are. SCSS / minification / autoprefixing are not built in; pre-compile to CSS yourself for now (a transform hook is on the roadmap).

## Lint

`xtatic` runs ESLint over your `.md`/`.mdx`/`.jsx`/`.js` files automatically before each build, with an opinionated zero-config baseline focused on catching import bugs early — typo'd named imports, missing files, default-vs-named confusion on the `xtatic:*` builtins. A lint failure exits 1 with the formatted ESLint output before any HTML is written.

**What's checked:**

- `import/no-unresolved` — flags imports of files that don't exist on disk.
- `import/named` — flags `import {Foo}` when `Foo` isn't actually exported.
- `import/no-duplicates` — flags two `import` statements for the same module.
- `xtatic/builtin-imports` — flags default imports, namespace imports, and unknown export names against `xtatic:builtins`/`xtatic:image`/`xtatic:style`. Errors carry the suggested fix (e.g. *"`xtatic:style` has no default export. Use `import {Style} from 'xtatic:style'` instead."*).
- `import/default` and `no-undef` — applied to `.js`/`.jsx` only. Off for `.md`/`.mdx` because xtatic's default-import semantics there bind the whole module object rather than `mm.default` (a deliberate divergence from ESM).

The config is currently frozen — no user override knob yet; that's a planned follow-up. `eslint`, `eslint-plugin-import`, and `eslint-plugin-mdx` are hard runtime dependencies, so there's nothing to install.

## Limitations

- No client-side runtime, hydration, or watch mode.
- `style` prop accepts strings only.
- Components must be synchronous.
- Path handling assumes POSIX separators.
- `.js` files cannot import `.md`/`.mdx` (Node has no loader for those).

## Tests

```sh
npm test
```

Tests use Node's built-in `node:test` runner. Most tests inject `memfs` and never touch disk; tests that need `.js` imports (and one no-injection smoke test) write to a `./test-tmp/` scratch directory at the repo root, which is gitignored and wiped at the start of each run.
