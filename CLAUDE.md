# immolate — Claude context

Static-site generator: MDX in, plain HTML out. The MDX is compiled and executed at build time; the output is pure HTML with no client-side runtime. See `README.md` for the user-facing description.

## Pipeline

`src/cli.js` → `src/index.js` `build()` → `src/paths.js` (resolve logical paths) → `src/compile.js` (MDX evaluate) → `src/tree.js` (assemble + apply defaults) → `src/render.js` (walk template chain) → write to `fs`.

Each module is small and focused; read the source rather than relying on this map.

## Non-obvious invariants

- **`fs` is dependency-injected** through `build({inputDir, outputDir, fs})`. The CLI passes `node:fs`; tests pass `memfs`. **Tests must never touch the real filesystem** — always pass `memfs` (`Volume.fromJSON` + `createFsFromVolume`).
- **`child_modules` is rewritten by the tool.** Anything a user file exports under that name is overwritten in tree assembly. Spec-mandated; don't add an "input wins" override.
- **Templates are parent-relative, not directory-scoped.** `D/template.md` wraps `D`'s children, **not** `D/index.md` itself. `D/index.md` is wrapped by `D`'s parent's `template.md` (one level up). The literal spec: `bar.template` defaults to `bar`'s parent's `child_modules.template`. This is unintuitive but intentional; if a future change wants directory-scoped behavior, that's a real spec change, not a bug fix.
- **Hidden subtrees are skipped wholesale at output write time.** A hidden parent's non-hidden children are NOT rendered to disk. Hidden modules remain keyed on the parent's `child_modules` for programmatic access from templates.
- **The `child_modules` iterator is non-enumerable**, defined per-instance via `Object.defineProperty`, so spread/`Object.keys` see only the children. Iteration is sorted-by-name and skips hidden modules.
- **Frontmatter requires both `remark-frontmatter` AND `remark-mdx-frontmatter`.** The first parses the `---` block; the second turns it into an MDX export. Easy to miss — `compile.js` configures both. Frontmatter keys are then promoted to top-level module properties; named exports win over frontmatter on collisions.
- **The root never gets a default template.** Other modules walk up; templates themselves don't auto-inherit (they have to declare a template explicitly).
- **The template chain is bounded** at depth 100 in `render.js` to catch self-referential cycles.

## JSX shim cheat sheet

`src/jsx-runtime.js` returns `{html: string}` directly — no VDOM. Exports `jsx`, `jsxs` (alias), `Fragment`. Tag types: string (HTML element), function (component), or module object (calls `mm.default`). Children: HTML objects pass through unescaped; modules render via `mm.default({})`; primitives are HTML-escaped; null/undefined/booleans render empty; arrays flatten. Attribute renames: `className` → `class`, `htmlFor` → `for`. Booleans use HTML conventions (bare on `true`, omitted on `false`/`null`/`undefined`).

## Workflow

- `npm test` runs the full Node test suite. Everything uses memfs; nothing writes to disk.
- **Commit whenever the suite is green.** Don't batch unrelated changes; checkpoint often.
- ESM only — `package.json` has `"type": "module"`, all imports use explicit `.js` extensions.

## Known scope cuts (deliberate)

- `style` prop accepts strings only; object form (`style={{color: 'red'}}`) stringifies as `[object Object]`.
- Components are synchronous; async MDX components aren't supported.
- POSIX path separators only; not tested on Windows.
