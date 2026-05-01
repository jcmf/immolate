# immolate — Claude context

Static-site generator: MDX in, plain HTML out. The MDX is compiled and executed at build time; the output is pure HTML with no client-side runtime. See `README.md` for the user-facing description.

## Pipeline

`src/cli.js` → `src/index.js` `build()` → `src/paths.js` (resolve logical paths) → `src/registry.js` (lazy-compile through a per-build cache) → `src/compile.js` (MDX `compile`+`run`, with `recma-imports.js` rewriting user `import`s into resolver calls) → `src/tree.js` (assemble + apply defaults) → `src/render.js` (walk layout chain) → write to `fs`.

Each module is small and focused; read the source rather than relying on this map.

## Non-obvious invariants

- **`fs` is dependency-injected** through `build({inputDir, outputDir, fs})` for `.md`/`.mdx` reads and all writes. `.js` reads are *not* injected — they go through Node's real `import()` (see below). Memfs-only tests therefore can't reference `.js` files; tests that need `.js` use real-fs scratch dirs under `./test-tmp/<slug>/`.
- **`childPages` and `name` are rewritten by the tool.** `childPages` is overwritten on every module with a freshly built sorted Array of direct children; `name` is set on every non-root module to its last path segment. Anything a user file exports under those names is clobbered. Spec-mandated; don't add an "input wins" override.
- **`date` and `title` are *defaulted* from `name`.** `assembleTree` parses each non-root module's name. A leading `YYYY-MM-DD` or `YYYYMMDD` (with month 01-12 and day 01-31, optionally followed by `-rest`) becomes `date`; the remainder (or the whole name when no date prefix) becomes `title` with dashes-to-spaces, run through npm `title` only if the spaced form is all-lowercase (preserves intentional casing like `THIS-is-a-TEST`). Unlike `childPages`/`name`, these are pure defaults — frontmatter or named exports win.
- **Layouts live in `layoutsDir`, not the input tree.** A page's `layout` is set either explicitly (`layout:` in frontmatter — accepts a string path resolved against `layoutsDir`, or a module object via `import`) or by the `defaultLayout` walk: `assembleTree` walks from each module up to the root and uses the first non-undefined `defaultLayout` it finds (starting at the module itself). `index.js` calls `resolveLayoutChain` *after* `assembleTree`, so string values inherited via `defaultLayout` get rewritten to the loaded module too. There's no longer any magic for files literally named `layout.md` in the input tree — those are just regular pages.
- **`childPages` is a plain `Array` sorted by `name`.** `assembleTree` rebuilds it from scratch and explicitly sorts after attach, so iteration order is guaranteed regardless of how `entries` is ordered when passed in. `index.js`'s `writeNode` reads `child.name` to derive the output path segment.
- **Frontmatter requires both `remark-frontmatter` AND `remark-mdx-frontmatter`.** The first parses the `---` block; the second turns it into an MDX export. Easy to miss — `compile.js` configures both. Frontmatter keys are then promoted to top-level module properties; named exports win over frontmatter on collisions.
- **The layout chain is bounded** at depth 100 in `render.js` to catch self-referential cycles.
- **A module's own properties leak into JSX expressions as bare identifiers.** `recma-self.js` scope-analyzes `_createMdxContent`, finds otherwise-unbound identifiers, and prepends `const { … } = props.__immolate_self ?? {};`. `registry.js` wraps `mm.default` so every render call passes `__immolate_self: mm`, and the closure captures the live `mm` (so `childPages`/`layout` added later by `tree.js` are visible). Built-in globals (`Math`, `Array`, …) are filtered out so they don't get accidentally shadowed; novel free identifiers that don't exist on `mm` simply destructure to `undefined`.
- **Imports are rewritten by a recma plugin, not real `import()`.** `compile.js` calls `@mdx-js/mdx`'s `compile` directly (not `evaluate`), runs the result via `new AsyncFunction(body)`, and passes a `__immolate_resolve` closure through `arguments[0]`. `recma-imports.js` rewrites every `await import('<spec>')` MDX produced into `await arguments[0].__immolate_resolve('<spec>')`. The dummy `baseUrl: 'file:///immolate/'` is required only to suppress MDX's runtime baseUrl check; it's never actually used because we removed every real `import()`.
- **`.md`/`.mdx` default-import semantics differ from ESM.** `import X from './foo.mdx'` binds X to the *whole module object*, not `mm.default`. The recma plugin enforces this by splitting the destructure: `const ns = await __immolate_resolve(spec); const X = ns; const {a, b} = ns;` for any `default` key in the pattern. `.js` keeps standard ESM semantics (default = `.default`).
- **Cycles work via a stable placeholder identity.** `registry.js`'s `loadMdx` sets `mdxModules.set(absPath, {mm: {}, status: 'compiling'})` *before* awaiting source/compile, so a circular re-entry returns the same `mm` object reference. After compile, `Object.assign(mm, compiled)` mutates the placeholder in place — anyone holding the reference sees the final shape by render time.
- **`.js` files do not go through MDX.** They're loaded via real `import(pathToFileURL(absPath).href)`, so relative `.js`→`.js` imports and bare specifiers (npm, `node:`) resolve via Node's normal resolver. `.js`→`.md`/`.mdx` is still unsupported (Node doesn't know how to load `.mdx`).

## JSX shim cheat sheet

`src/jsx-runtime.js` returns `{html: string}` directly — no VDOM. Exports `jsx`, `jsxs` (alias), `Fragment`. Tag types: string (HTML element), function (component), or module object (calls `mm.default`). Children: HTML objects pass through unescaped; modules render via `mm.default({})`; primitives are HTML-escaped; null/undefined/booleans render empty; arrays flatten. Attribute renames: `className` → `class`, `htmlFor` → `for`. Booleans use HTML conventions (bare on `true`, omitted on `false`/`null`/`undefined`).

## Workflow

- `npm test` runs the full Node test suite. Three flavors:
  - **memfs tests** (most of them) inject a memfs `fs`; nothing touches disk.
  - **real-fs tests** (`test/cli.test.js`, `test/imports-js.test.js`, `test/smoke.test.js`) scratch under `./test-tmp/<file>/...`. Each file's top-level `before` wipes only its own subtree (test files run in parallel, so a file-wide wipe of `test-tmp/` will race other files' fixtures). `test-tmp/` is gitignored. Slugs must be unique per test in the file — Node caches `import()` by URL, so reusing a slug serves stale `.js` content.
  - The smoke test passes no fs injection, exercising the default `node:fs` code path end-to-end.
- **After making a change and seeing the suite green, commit immediately — don't wait to be asked.** Don't batch unrelated changes; checkpoint often.
- ESM only — `package.json` has `"type": "module"`, all imports use explicit `.js` extensions.

## Known scope cuts (deliberate)

- `style` prop accepts strings only; object form (`style={{color: 'red'}}`) stringifies as `[object Object]`.
- Components are synchronous; async MDX components aren't supported.
- POSIX path separators only; not tested on Windows.
