# immolate — Claude context

Static-site generator: MDX in, plain HTML out. The MDX is compiled and executed at build time; the output is pure HTML with no client-side runtime. See `README.md` for the user-facing description.

## Pipeline

`src/cli.js` → `src/index.js` `build()` → `src/paths.js` (resolve logical paths) → `src/registry.js` (lazy-compile through a per-build cache) → `src/compile.js` (MDX `compile`+`run`, with `recma-imports.js` rewriting user `import`s into resolver calls) → `src/tree.js` (assemble + apply defaults) → `src/render.js` (walk template chain) → write to `fs`.

Each module is small and focused; read the source rather than relying on this map.

## Non-obvious invariants

- **`fs` is dependency-injected** through `build({inputDir, outputDir, fs})` for `.md`/`.mdx` reads and all writes. `.js` reads are *not* injected — they go through Node's real `import()` (see below). Memfs-only tests therefore can't reference `.js` files; tests that need `.js` use real-fs scratch dirs under `./test-tmp/<slug>/`.
- **`child_modules` is rewritten by the tool.** Anything a user file exports under that name is overwritten in tree assembly. Spec-mandated; don't add an "input wins" override.
- **Templates are parent-relative, not directory-scoped.** `D/template.md` wraps `D`'s children, **not** `D/index.md` itself. `D/index.md` is wrapped by `D`'s parent's `template.md` (one level up). The literal spec: `bar.template` defaults to `bar`'s parent's `child_modules.template`. This is unintuitive but intentional; if a future change wants directory-scoped behavior, that's a real spec change, not a bug fix.
- **Hidden subtrees are skipped wholesale at output write time.** A hidden parent's non-hidden children are NOT rendered to disk. Hidden modules remain keyed on the parent's `child_modules` for programmatic access from templates.
- **The `child_modules` iterator is non-enumerable**, defined per-instance via `Object.defineProperty`, so spread/`Object.keys` see only the children. Iteration is sorted-by-name and skips hidden modules.
- **Frontmatter requires both `remark-frontmatter` AND `remark-mdx-frontmatter`.** The first parses the `---` block; the second turns it into an MDX export. Easy to miss — `compile.js` configures both. Frontmatter keys are then promoted to top-level module properties; named exports win over frontmatter on collisions.
- **The root never gets a default template.** Other modules walk up; templates themselves don't auto-inherit (they have to declare a template explicitly).
- **The template chain is bounded** at depth 100 in `render.js` to catch self-referential cycles.
- **Imports are rewritten by a recma plugin, not real `import()`.** `compile.js` calls `@mdx-js/mdx`'s `compile` directly (not `evaluate`), runs the result via `new AsyncFunction(body)`, and passes a `__immolate_resolve` closure through `arguments[0]`. `recma-imports.js` rewrites every `await import('<spec>')` MDX produced into `await arguments[0].__immolate_resolve('<spec>')`. The dummy `baseUrl: 'file:///immolate/'` is required only to suppress MDX's runtime baseUrl check; it's never actually used because we removed every real `import()`.
- **`.md`/`.mdx` default-import semantics differ from ESM.** `import X from './foo.mdx'` binds X to the *whole module object*, not `mm.default`. The recma plugin enforces this by splitting the destructure: `const ns = await __immolate_resolve(spec); const X = ns; const {a, b} = ns;` for any `default` key in the pattern. `.js` keeps standard ESM semantics (default = `.default`).
- **Cycles work via a stable placeholder identity.** `registry.js`'s `loadMdx` sets `mdxModules.set(absPath, {mm: {}, status: 'compiling'})` *before* awaiting source/compile, so a circular re-entry returns the same `mm` object reference. After compile, `Object.assign(mm, compiled)` mutates the placeholder in place — anyone holding the reference sees the final shape by render time.
- **`.js` files do not go through MDX.** They're loaded via real `import(pathToFileURL(absPath).href)`, so relative `.js`→`.js` imports and bare specifiers (npm, `node:`) resolve via Node's normal resolver. `.js`→`.md`/`.mdx` is still unsupported (Node doesn't know how to load `.mdx`).

## JSX shim cheat sheet

`src/jsx-runtime.js` returns `{html: string}` directly — no VDOM. Exports `jsx`, `jsxs` (alias), `Fragment`. Tag types: string (HTML element), function (component), or module object (calls `mm.default`). Children: HTML objects pass through unescaped; modules render via `mm.default({})`; primitives are HTML-escaped; null/undefined/booleans render empty; arrays flatten. Attribute renames: `className` → `class`, `htmlFor` → `for`. Booleans use HTML conventions (bare on `true`, omitted on `false`/`null`/`undefined`).

## Workflow

- `npm test` runs the full Node test suite. Three flavors:
  - **memfs tests** (most of them) inject a memfs `fs`; nothing touches disk.
  - **real-fs tests** (`test/imports-js.test.js`, `test/smoke.test.js`) write inputs and outputs under `./test-tmp/<slug>/`. Each file's top-level `before` wipes its scratch area; `test-tmp/` is gitignored. Slugs must be unique per test in the file — Node caches `import()` by URL, so reusing a slug serves stale `.js` content.
  - The smoke test passes no fs injection, exercising the default `node:fs` code path end-to-end.
- **Commit whenever the suite is green.** Don't batch unrelated changes; checkpoint often.
- ESM only — `package.json` has `"type": "module"`, all imports use explicit `.js` extensions.

## Known scope cuts (deliberate)

- `style` prop accepts strings only; object form (`style={{color: 'red'}}`) stringifies as `[object Object]`.
- Components are synchronous; async MDX components aren't supported.
- POSIX path separators only; not tested on Windows.
