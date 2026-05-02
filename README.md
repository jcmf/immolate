# immolate

A small static-site generator: MDX in, plain HTML out. The MDX is compiled and executed at build time, so the output is just HTML — no client-side runtime, no hydration.

## Install & run

```sh
npm install
node src/cli.js [TOP_DIR]
```

`TOP_DIR` defaults to the current directory. By default, immolate walks `TOP_DIR/pages/**/*.{md,mdx}` and writes to `TOP_DIR/site/`.

To override the input or output location, add an `immolate` section to `TOP_DIR/package.json`:

```json
{
  "immolate": {
    "inputDir": "src/pages",
    "outputDir": "dist",
    "layoutsDir": "src/layouts"
  }
}
```

Relative paths in config are resolved against `TOP_DIR`, not the working directory; absolute paths are used as-is.

## How input maps to output

`immolate` walks `INPUT_DIR/**/*.{md,mdx}`. Each file becomes `OUTPUT_DIR/<path>/index.html`. The four forms below are **equivalent and mutually exclusive** — putting two of them in the same input tree is an error:

| Input                                | Output                            |
| ------------------------------------ | --------------------------------- |
| `INPUT_DIR/foo/bar.md`               | `OUTPUT_DIR/foo/bar/index.html`   |
| `INPUT_DIR/foo/bar.mdx`              | same                              |
| `INPUT_DIR/foo/bar/index.md`         | same                              |
| `INPUT_DIR/foo/bar/index.mdx`        | same                              |

`INPUT_DIR/index.md` (or `.mdx`) is the root and writes to `OUTPUT_DIR/index.html`.

## Pages

Markdown is rendered normally. JSX inside MDX is evaluated against immolate's JSX runtime, which produces HTML strings directly — no React, no virtual DOM.

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

1. **Explicit**: set `layout: <name>` in frontmatter (or as a named export). The string is treated as a path relative to `LAYOUTS_DIR` (default: `TOP_DIR/layouts`, configurable via `immolate.layoutsDir` in `package.json`). The `.md`/`.mdx` suffix is optional; with no suffix `.mdx` is preferred. Subpaths work: `layout: posts/article`.
2. **Inherited via `defaultLayout`**: if `layout` isn't set, immolate walks from the module up to the root looking for a `defaultLayout`, and uses the first one it finds. The walk starts at the module itself, so a module's own `defaultLayout` applies to it. Set `defaultLayout` on the root to give every page a default; set it on a subdirectory's `index.md` to override for that subtree.

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

A small set of helpers ship with immolate. Like Node's `node:*` modules, they're exposed under an `immolate:` scheme and must be imported explicitly:

```mdx
import {html, readfile} from 'immolate:builtins';

{html('<!DOCTYPE html>')}

<pre>{readfile('./snippet.txt')}</pre>
```

Available named exports:

- `html(s)` — wrap a string so the JSX runtime emits it raw, without HTML-escaping. Useful for doctypes, inline SVG, or any time you've already got trusted markup.
- `readfile(spec)` — synchronously read a file as UTF-8 at build time. Specs starting with `/` resolve against `TOP_DIR`; everything else resolves against the importing file's directory. Throws a clear error if the file is missing.

Importing from `immolate:builtins` works identically in `.md`, `.mdx`, and `.jsx` files. Names you don't import don't shadow anything, so you're free to define a local `html` or `readfile` of your own.

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
