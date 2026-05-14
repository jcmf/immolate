// CSS-static font cascade engine for mode:'css-static' subsetting.
//
// Walks each page's HTML (parse5) and the CSS reaching it (css-tree), computes
// `font-family`/`font-weight`/`font-style` for every text-bearing element via
// a basic cascade, matches that against the union of declared faces (<Font>
// calls + user @font-face), and attributes each rendered code point to the
// matched face. The result is consumed by font.js to build per-face subset
// glyph sets.
//
// Deliberately approximate:
//   - Pseudo-classes (:hover, :focus, :nth-child(...), :not(...), etc.) are
//     evaluated as always-true so weight/style/family overrides applied only
//     in those states still contribute glyphs. Over-includes a bit, never
//     under-includes.
//   - Pseudo-element `content:` extraction is NOT yet implemented — icon
//     fonts driven by `::before { content: "\f001" }` won't have their code
//     points attributed. With hedge:'full' (commit 4) those glyphs still
//     ship in the complement subset, so the failure mode is byte-bloat, not
//     tofu. Documented as a known gap.
//   - `font-weight: bolder`/`lighter` round to 700/300 (no parent-relative
//     resolution).
//   - `font-stretch` is parsed but treated as a tie-breaker only; no current
//     test exercises a stretch-only fork.
//   - Combinators supported: descendant (` `), child (`>`), adjacent
//     sibling (`+`), general sibling (`~`). Selectors with `,` (lists) are
//     split per selector. `:not(...)` evaluates always-true.

import { parse, defaultTreeAdapter } from 'parse5';
import * as csstree from 'css-tree';

// ---- UA stylesheet (the bits that affect font cascade) -------------------

const UA_BOLD = new Set(['b', 'strong', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th']);
const UA_ITALIC = new Set(['em', 'i', 'cite', 'dfn', 'var', 'address']);
const UA_MONO = new Set(['code', 'kbd', 'pre', 'samp', 'tt']);

// Elements whose content is never rendered as text (no glyphs).
const NON_RENDERED = new Set(['script', 'style', 'template', 'noscript', 'head', 'title', 'meta', 'link']);

// Block/flow elements that don't contribute to text glyph rendering even if
// they have text-node children (rare; defensive). Currently empty — kept as
// a hook for future tuning.

// Default computed font for the root.
const ROOT_COMPUTED = {
  family: ['serif'],
  weight: 400,
  style: 'normal',
  stretch: 'normal',
};

// ---- value parsers --------------------------------------------------------

function parseFontFamily(value) {
  // 'Arial', "Helvetica Neue", sans-serif → ['Arial', 'Helvetica Neue', 'sans-serif']
  const out = [];
  const parts = value.match(/(?:"[^"]*"|'[^']*'|[^,])+/g) ?? [];
  for (const p of parts) {
    let t = p.trim();
    if (!t) continue;
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1);
    }
    out.push(t);
  }
  return out;
}

function parseFontWeight(value, parentWeight) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'normal') return 400;
  if (v === 'bold') return 700;
  if (v === 'bolder') {
    // Spec: bolder relative to parent — table-driven. Approximate.
    if (parentWeight < 350) return 400;
    if (parentWeight < 550) return 700;
    if (parentWeight < 750) return 900;
    return 900;
  }
  if (v === 'lighter') {
    if (parentWeight < 550) return 100;
    if (parentWeight < 750) return 400;
    return 700;
  }
  return null;
}

function parseFontStyle(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'normal' || v === 'italic' || v === 'oblique') return v;
  if (v.startsWith('oblique')) return 'oblique';
  return null;
}

function parseFontStretch(value) {
  if (typeof value !== 'string') return null;
  return value.trim().toLowerCase();
}

// `font:` shorthand: at minimum `<style> <weight> <size>/<line-height> <family>`.
// Many forms are valid; we extract what we can.
function parseFontShorthand(value) {
  const out = {};
  // Find the family list — everything after the last `/<line-height>` or after
  // the size token. Simplification: find the first comma-or-EOL chunk that
  // contains a recognized family-looking token.
  const tokens = value.match(/"[^"]*"|'[^']*'|[^,\s]+/g) ?? [];
  // Style/weight/variant are early tokens before the size.
  const SIZE_RE = /^\d+(\.\d+)?(px|em|rem|pt|%|ex|ch|vw|vh|vmin|vmax)$|^(xx-small|x-small|small|medium|large|x-large|xx-large|larger|smaller)$/;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (parseFontStyle(t)) {
      out.style = parseFontStyle(t);
      i++;
      continue;
    }
    const w = parseFontWeight(t, 400);
    if (w !== null && t !== 'normal') {
      // 'normal' could be style or weight; we already consumed style if
      // matched. For ambiguity, prefer weight here.
      out.weight = w;
      i++;
      continue;
    }
    if (t === 'normal') {
      // skip — could be style/weight/variant default
      i++;
      continue;
    }
    if (SIZE_RE.test(t) || t.includes('/')) {
      // size/line-height — skip
      i++;
      // The rest is family list
      out.family = parseFontFamily(value.slice(value.indexOf(t) + t.length).trim());
      return out;
    }
    i++;
  }
  return out;
}

// Parse `content:` value into the set of code points it contributes. Returns
// null if the value is functional/dynamic (counter(), attr(), etc.) — those
// can't be statically resolved.
function parseContentString(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === 'normal' || v === 'none') return '';
  // Functional values we can't resolve.
  if (/\b(counter|counters|attr|element|target-counter|url)\(/.test(v)) return null;
  // Concatenation of strings: "a" " " "b"
  const parts = v.match(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g);
  if (!parts) return null;
  let out = '';
  for (const p of parts) {
    let inner = p.slice(1, -1);
    // Decode CSS \HEX escapes.
    inner = inner.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    );
    inner = inner.replace(/\\(.)/g, '$1');
    out += inner;
  }
  return out;
}

// ---- selector → element matching -----------------------------------------

// Convert a css-tree Selector node into a small array of compound parts plus
// combinators: [{compound, combinator}, …]. The last entry has combinator=null.
function flattenSelector(selectorNode) {
  const parts = [];
  let current = { compound: [], combinator: null };
  for (const child of selectorNode.children) {
    if (child.type === 'Combinator' || child.type === 'WhiteSpace') {
      const c = child.type === 'WhiteSpace' ? ' ' : child.name;
      parts.push({ compound: current.compound, combinator: c });
      current = { compound: [], combinator: null };
    } else {
      current.compound.push(child);
    }
  }
  parts.push(current);
  return parts;
}

function getAttr(element, name) {
  if (!element.attrs) return null;
  for (const a of element.attrs) if (a.name === name) return a.value;
  return null;
}

function elementClassList(element) {
  const v = getAttr(element, 'class');
  if (!v) return [];
  return v.split(/\s+/).filter(Boolean);
}

function matchCompound(compound, element) {
  if (!element || element.nodeName === '#document' || element.nodeName === '#text') return false;
  const tag = element.tagName?.toLowerCase();
  for (const part of compound) {
    switch (part.type) {
      case 'TypeSelector': {
        if (part.name === '*') break;
        if (part.name.toLowerCase() !== tag) return false;
        break;
      }
      case 'ClassSelector': {
        if (!elementClassList(element).includes(part.name)) return false;
        break;
      }
      case 'IdSelector': {
        if (getAttr(element, 'id') !== part.name) return false;
        break;
      }
      case 'AttributeSelector': {
        const v = getAttr(element, part.name.name);
        if (v == null) return false;
        if (!part.matcher) break;
        const want = part.value?.value ?? part.value?.name ?? '';
        const wantStr = String(want).replace(/^"|"$/g, '').replace(/^'|'$/g, '');
        switch (part.matcher) {
          case '=': if (v !== wantStr) return false; break;
          case '~=': if (!v.split(/\s+/).includes(wantStr)) return false; break;
          case '|=': if (v !== wantStr && !v.startsWith(`${wantStr}-`)) return false; break;
          case '^=': if (!v.startsWith(wantStr)) return false; break;
          case '$=': if (!v.endsWith(wantStr)) return false; break;
          case '*=': if (!v.includes(wantStr)) return false; break;
          default: break;
        }
        break;
      }
      case 'PseudoClassSelector':
      case 'PseudoElementSelector':
        // Pseudo-classes evaluate always-true (over-include hedge). Pseudo-
        // elements are handled separately by the caller — when a selector
        // ends in ::before/::after we attribute to a synthetic pseudo node.
        break;
      default:
        // Unknown — be conservative and let it match (over-include).
        break;
    }
  }
  return true;
}

// Returns true if `selector` (flattened parts) matches `element` walking
// the parse5 tree.
function matchSelector(parts, element) {
  // Walk from the rightmost compound (target) leftward.
  if (parts.length === 0) return false;
  let i = parts.length - 1;
  if (!matchCompound(parts[i].compound, element)) return false;
  let current = element;
  let combinator = parts[i].combinator; // null for last
  i--;
  while (i >= 0) {
    combinator = parts[i + 1] ? parts[i].combinator : null;
    const target = parts[i];
    const combo = parts[i + 1] && parts[i] ? parts[i].combinator : null;
    // Actually combinator between i and i+1 lives on parts[i].combinator.
    // (Already set above.)
    const wantCombinator = parts[i].combinator;
    if (wantCombinator === ' ') {
      // Descendant: walk ancestors.
      let p = current.parentNode;
      let matched = false;
      while (p && p.nodeName !== '#document') {
        if (matchCompound(target.compound, p)) { matched = true; current = p; break; }
        p = p.parentNode;
      }
      if (!matched) return false;
    } else if (wantCombinator === '>') {
      const p = current.parentNode;
      if (!p || p.nodeName === '#document') return false;
      if (!matchCompound(target.compound, p)) return false;
      current = p;
    } else if (wantCombinator === '+') {
      const p = current.parentNode;
      if (!p) return false;
      const siblings = p.childNodes ?? [];
      const idx = siblings.indexOf(current);
      // Previous element sibling.
      let prev = null;
      for (let j = idx - 1; j >= 0; j--) {
        if (siblings[j].nodeName !== '#text' && siblings[j].nodeName?.[0] !== '#') {
          prev = siblings[j];
          break;
        }
      }
      if (!prev || !matchCompound(target.compound, prev)) return false;
      current = prev;
    } else if (wantCombinator === '~') {
      const p = current.parentNode;
      if (!p) return false;
      const siblings = p.childNodes ?? [];
      const idx = siblings.indexOf(current);
      let matched = false;
      for (let j = idx - 1; j >= 0; j--) {
        if (siblings[j].nodeName?.[0] !== '#' && matchCompound(target.compound, siblings[j])) {
          matched = true;
          current = siblings[j];
          break;
        }
      }
      if (!matched) return false;
    } else {
      return false;
    }
    i--;
  }
  return true;
}

// ---- specificity -----------------------------------------------------------

function specificityOfSelector(selectorNode) {
  let a = 0, b = 0, c = 0;
  csstree.walk(selectorNode, (node) => {
    switch (node.type) {
      case 'IdSelector': a++; break;
      case 'ClassSelector':
      case 'AttributeSelector':
      case 'PseudoClassSelector': b++; break;
      case 'TypeSelector':
        if (node.name !== '*') c++;
        break;
      case 'PseudoElementSelector': c++; break;
      default: break;
    }
  });
  return a * 10000 + b * 100 + c;
}

// ---- CSS rule extraction --------------------------------------------------

// Walks a CSS AST and collects:
//   - flat rules: [{selectors: SelectorNode[], decls: {prop: value}, specificities: number[], important: {prop: bool}, sourceOrder: number}]
//   - @font-face declarations: [{family, weight, style, stretch, unicodeRange, sourceOrigin}]
function extractCssArtifacts(cssText, sourceOrderBase = 0) {
  let ast;
  try {
    ast = csstree.parse(cssText, { positions: false });
  } catch {
    return { rules: [], faces: [] };
  }
  const rules = [];
  const faces = [];
  let order = sourceOrderBase;

  function walkNode(node) {
    if (node.type === 'Rule') {
      const selectors = node.prelude.children ? [...node.prelude.children] : [];
      const decls = {};
      const important = {};
      if (node.block?.children) {
        for (const decl of node.block.children) {
          if (decl.type !== 'Declaration') continue;
          const v = csstree.generate(decl.value).trim();
          decls[decl.property.toLowerCase()] = v;
          if (decl.important) important[decl.property.toLowerCase()] = true;
        }
      }
      const specs = selectors.map((s) => specificityOfSelector(s));
      const flattened = selectors.map((s) => flattenSelector(s));
      rules.push({ selectors, flattened, decls, important, specs, order: order++ });
    } else if (node.type === 'Atrule') {
      if (node.name === 'font-face' && node.block?.children) {
        const face = { family: null, weight: 400, style: 'normal', stretch: 'normal', unicodeRange: null };
        for (const decl of node.block.children) {
          if (decl.type !== 'Declaration') continue;
          const v = csstree.generate(decl.value).trim();
          switch (decl.property.toLowerCase()) {
            case 'font-family': face.family = parseFontFamily(v)[0] ?? null; break;
            case 'font-weight': face.weight = v; break;
            case 'font-style': face.style = parseFontStyle(v) ?? 'normal'; break;
            case 'font-stretch': face.stretch = parseFontStretch(v) ?? 'normal'; break;
            case 'unicode-range': face.unicodeRange = v; break;
          }
        }
        if (face.family) faces.push(face);
      } else if (node.name === 'media' || node.name === 'supports' || node.name === 'layer') {
        // Treat as always-applying (over-include). Recurse into the block.
        if (node.block?.children) {
          for (const child of node.block.children) walkNode(child);
        }
      }
      // Other at-rules are ignored.
    }
  }

  if (ast.children) {
    for (const child of ast.children) walkNode(child);
  }
  return { rules, faces };
}

// ---- face matching --------------------------------------------------------

// Parse `unicode-range:` into a list of [low, high] code-point ranges.
function parseUnicodeRange(s) {
  if (typeof s !== 'string') return null;
  const out = [];
  for (const tok of s.split(',')) {
    const t = tok.trim();
    if (!t.startsWith('U+') && !t.startsWith('u+')) continue;
    const body = t.slice(2);
    if (body.includes('-')) {
      const [a, b] = body.split('-');
      out.push([parseInt(a, 16), parseInt(b, 16)]);
    } else if (body.includes('?')) {
      const lo = parseInt(body.replace(/\?/g, '0'), 16);
      const hi = parseInt(body.replace(/\?/g, 'F'), 16);
      out.push([lo, hi]);
    } else {
      const n = parseInt(body, 16);
      out.push([n, n]);
    }
  }
  return out.length ? out : null;
}

function codePointInRanges(cp, ranges) {
  if (!ranges) return true;
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function normalizeDeclaredWeight(w) {
  if (typeof w === 'number') return [w, w];
  if (typeof w !== 'string') return [400, 400];
  const v = w.trim().toLowerCase();
  if (v === 'normal') return [400, 400];
  if (v === 'bold') return [700, 700];
  // variable: "100 900"
  const m = v.match(/^(\d+)\s+(\d+)$/);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = parseInt(v, 10);
  if (!Number.isNaN(n)) return [n, n];
  return [400, 400];
}

// Distance from requested weight to a declared face's weight range. 0 if
// requested is inside the variable-font range.
function weightDistance(requested, [lo, hi]) {
  if (requested >= lo && requested <= hi) return 0;
  if (requested < lo) return lo - requested;
  return requested - hi;
}

function styleDistance(requested, declared) {
  if (requested === declared) return 0;
  if (requested === 'italic' && declared === 'oblique') return 1;
  if (requested === 'oblique' && declared === 'italic') return 1;
  return 100;
}

// Best-match face for a request from a set of declared faces matching family
// (case-insensitive). Returns the face or null.
function bestFace(requested, declaredByFamily) {
  let best = null;
  let bestScore = Infinity;
  for (const f of declaredByFamily) {
    const wd = weightDistance(requested.weight, normalizeDeclaredWeight(f.weight));
    const sd = styleDistance(requested.style, f.style);
    const score = sd * 10000 + wd;
    if (score < bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

// ---- DOM walk --------------------------------------------------------------

function isElement(node) {
  return node && node.nodeName && node.nodeName[0] !== '#' && node.tagName;
}

function getInlineStyleDecls(element) {
  const s = getAttr(element, 'style');
  if (!s) return {};
  const out = {};
  for (const part of s.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (prop) out[prop] = val;
  }
  return out;
}

function computeForElement(element, parentComputed, rules) {
  // Collect matched declarations + inline.
  const matched = [];
  for (const rule of rules) {
    for (let i = 0; i < rule.flattened.length; i++) {
      if (matchSelector(rule.flattened[i], element)) {
        matched.push({ decls: rule.decls, important: rule.important, spec: rule.specs[i], order: rule.order });
        break;
      }
    }
  }
  matched.sort((a, b) =>
    (a.spec - b.spec) || (a.order - b.order),
  );
  const inline = getInlineStyleDecls(element);

  // Build cascaded values for our four properties + font shorthand.
  function pick(prop) {
    let value = undefined;
    let importantValue = undefined;
    for (const m of matched) {
      if (m.decls[prop] !== undefined) {
        if (m.important[prop]) importantValue = m.decls[prop];
        else value = m.decls[prop];
      }
      // Also handle `font:` shorthand at the rule level (lower precedence than
      // longhands per CSS, but our cascade is monotonic so longhand wins by
      // later assignment if both present in one rule).
      if (m.decls['font'] !== undefined) {
        const sh = parseFontShorthand(m.decls['font']);
        if (sh[propToShort(prop)] !== undefined) {
          const v = String(sh[propToShort(prop)]);
          if (m.important['font']) importantValue = v;
          else value = v;
        }
      }
    }
    if (inline[prop] !== undefined) value = inline[prop];
    if (inline['font'] !== undefined) {
      const sh = parseFontShorthand(inline['font']);
      if (sh[propToShort(prop)] !== undefined) value = String(sh[propToShort(prop)]);
    }
    if (importantValue !== undefined) return importantValue;
    return value;
  }

  function propToShort(longhand) {
    return longhand.replace(/^font-/, '');
  }

  let family = parentComputed.family;
  const fRaw = pick('font-family');
  if (fRaw) family = parseFontFamily(fRaw);

  let weight = parentComputed.weight;
  const wRaw = pick('font-weight');
  if (wRaw !== undefined) {
    const w = parseFontWeight(wRaw, parentComputed.weight);
    if (w !== null) weight = w;
  }

  let style = parentComputed.style;
  const sRaw = pick('font-style');
  if (sRaw !== undefined) {
    const s = parseFontStyle(sRaw);
    if (s !== null) style = s;
  }

  let stretch = parentComputed.stretch;
  const stRaw = pick('font-stretch');
  if (stRaw !== undefined) {
    const st = parseFontStretch(stRaw);
    if (st !== null) stretch = st;
  }

  // UA defaults — applied with LOW specificity, so they're overridden by any
  // matched rule or inline style. Since we already let matched/inline override
  // before this point, only apply UA defaults when the property is still
  // inherited from the parent (i.e., nothing explicitly set it on this elem).
  const tag = element.tagName?.toLowerCase();
  if (tag) {
    const noAuthorWeight = pick('font-weight') === undefined;
    const noAuthorStyle = pick('font-style') === undefined;
    const noAuthorFamily = pick('font-family') === undefined && pick('font') === undefined;
    if (noAuthorWeight && UA_BOLD.has(tag)) weight = 700;
    if (noAuthorStyle && UA_ITALIC.has(tag)) style = 'italic';
    if (noAuthorFamily && UA_MONO.has(tag)) family = ['monospace'];
  }

  return { family, weight, style, stretch };
}

// ---- main API -------------------------------------------------------------

// Build a map: lowercased family name → array of declared faces with that
// family. Inputs are merged: `<Font>` calls + @font-face rules from CSS.
function buildFamilyIndex(faces) {
  const idx = new Map();
  for (const f of faces) {
    const k = f.family.toLowerCase();
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(f);
  }
  return idx;
}

// Match a requested (family-list, weight, style) against declared faces.
// Returns the matched face object or null.
function matchRequestedFace(requested, familyIndex) {
  for (const fam of requested.family) {
    const candidates = familyIndex.get(fam.toLowerCase());
    if (!candidates || candidates.length === 0) continue;
    return bestFace(requested, candidates);
  }
  return null;
}

// Walk an element's text descendants, calling `onText(elem, text)`. Skips
// NON_RENDERED tags entirely.
function* walkTextRuns(element) {
  if (!element.childNodes) return;
  for (const child of element.childNodes) {
    if (child.nodeName === '#text') {
      if (child.value) yield { element, text: child.value };
    } else if (isElement(child)) {
      const tag = child.tagName.toLowerCase();
      if (NON_RENDERED.has(tag)) continue;
      yield* walkTextRuns(child);
    }
  }
}

// Single deferred id for a face (consumed by font.js to look up code points).
export function faceKey(face, precision) {
  const family = face.family.toLowerCase();
  if (precision === 'family') return family;
  const [wlo, whi] = normalizeDeclaredWeight(face.weight);
  return `${family}\0${wlo}-${whi}\0${face.style}\0${face.unicodeRange ?? ''}`;
}

// Public entry: compute per-face code-point sets for every page.
//
//   pages          : [{outPath, html}]
//   getCssForPage  : (html) => string[]  CSS reaching this page
//   registeredFaces: [{family, weight, style, unicodeRange}] from <Font> calls
//   precision      : 'family' | 'face'
//
// Returns Map<faceKey, Set<codepoint>>.
export function computeCodePointsByFace({
  pages,
  getCssForPage,
  registeredFaces,
  precision = 'face',
}) {
  const byFace = new Map();

  for (const page of pages) {
    const doc = parse(page.html);
    const cssTexts = getCssForPage(page.html) ?? [];

    // Pull inline <style> blocks from the page itself.
    const inlineStyles = [];
    (function collectInlineStyles(node) {
      if (!node.childNodes) return;
      for (const c of node.childNodes) {
        if (isElement(c) && c.tagName.toLowerCase() === 'style') {
          const txt = (c.childNodes ?? []).map((t) => t.value ?? '').join('');
          if (txt) inlineStyles.push(txt);
        } else if (isElement(c)) {
          collectInlineStyles(c);
        }
      }
    })(doc);

    const allRules = [];
    const cssFaces = [];
    let order = 0;
    for (const text of [...cssTexts, ...inlineStyles]) {
      const { rules, faces } = extractCssArtifacts(text, order);
      order += rules.length;
      allRules.push(...rules);
      cssFaces.push(...faces);
    }

    // Merge declared faces: <Font> calls first (they're subsettable), then CSS
    // @font-face rules.
    const allFaces = [
      ...registeredFaces.map((f) => ({ ...f, _fromFont: true })),
      ...cssFaces.map((f) => ({ ...f, _fromFont: false })),
    ];
    const familyIndex = buildFamilyIndex(allFaces);

    // DOM walk with cascade. Find the body (or document if absent).
    function walk(element, parentComputed) {
      const tag = element.tagName?.toLowerCase();
      if (tag && NON_RENDERED.has(tag)) return;
      const computed = isElement(element)
        ? computeForElement(element, parentComputed, allRules)
        : parentComputed;

      if (isElement(element)) {
        for (const child of element.childNodes ?? []) {
          if (child.nodeName === '#text' && child.value) {
            attributeText(child.value, computed);
          } else if (isElement(child)) {
            walk(child, computed);
          }
        }
      } else if (element.childNodes) {
        for (const child of element.childNodes) {
          if (isElement(child)) walk(child, computed);
        }
      }
    }

    function attributeText(text, computed) {
      const matched = matchRequestedFace(computed, familyIndex);
      if (!matched) return; // Falls through to system fonts — not our font.
      if (!matched._fromFont) return; // Declared in user CSS only; not subsettable.
      const ranges = parseUnicodeRange(matched.unicodeRange);
      const key = faceKey(matched, precision);
      let set = byFace.get(key);
      if (!set) byFace.set(key, (set = new Set()));
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (codePointInRanges(cp, ranges)) set.add(cp);
      }
    }

    walk(doc, ROOT_COMPUTED);
  }

  return byFace;
}

// Re-exports for tests.
export const _internal = {
  parseFontFamily,
  parseFontWeight,
  parseFontStyle,
  parseUnicodeRange,
  extractCssArtifacts,
  defaultTreeAdapter,
};
