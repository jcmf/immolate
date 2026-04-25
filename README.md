# immolate

A small static-site generator: MDX in, plain HTML out. The MDX is compiled and executed at build time, so the output is just HTML — no client-side runtime, no hydration.

## Install & run

```sh
npm install
node src/cli.js INPUT_DIR OUTPUT_DIR
```

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

## Templates

A file named `template.md` (or `.mdx`) in directory `D` wraps the **children** of `D` — not `D/index.md` itself. The template receives the wrapped module as `props.children`, so it can read the page's metadata before rendering its content:

```mdx
<!-- INPUT_DIR/template.md -->
<html>
  <head><title>{props.children.title}</title></head>
  <body>{props.children}</body>
</html>
```

Inheritance walks up the directory tree: a page first looks in its parent's `template.md`, then in the grandparent's, and so on, until something matches. The root page (`INPUT_DIR/index.md`) never inherits a template by default.

A module named `template` defaults to `hidden: true`, so it isn't written to disk on its own. (See below.)

## Hidden pages

Set `hidden: true` in frontmatter (or via `export const hidden = true`) to keep a module out of the output. Hidden modules and their entire subtrees are skipped at write time — but they remain keyed on the parent's `child_modules`, so templates and other pages can still reach them for navigation, listings, etc.

## The module tree

After compilation, every page is a module object exposing:

- `default(props)` — render function returning `{html: string}`
- `child_modules` — iterable of non-hidden child modules in name-sorted order; hidden children are still keyed for direct access
- `template` — the page's template module (auto-inherited or explicitly set)
- `hidden` — boolean
- frontmatter keys + any named exports

Use `for (const child of mm.child_modules) { ... }` to build navigation menus or listings; iteration always skips hidden entries.

## Custom components

Any module can be used as a JSX tag. The runtime calls its `default(props)` and inlines the result.

## Limitations

- No client-side runtime, hydration, or watch mode.
- `style` prop accepts strings only.
- Components must be synchronous.
- Path handling assumes POSIX separators.

## Tests

```sh
npm test
```

Tests use Node's built-in `node:test` runner with `memfs`; no test touches the real filesystem.
