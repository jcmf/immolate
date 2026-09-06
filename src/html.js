// Process a .html input file: parse with parse5 (source locations on), route
// every whitelisted (tag, attribute) reference through the per-importer
// asset() — the same runtime that recma-assets wires up for plain tags in
// .md/.mdx/.jsx — and splice the resulting tokens back into the original
// source text. Everything the parser didn't rewrite (whitespace, comments,
// doctype, attribute quoting, even markup the HTML algorithm would relocate)
// ships byte-identical, because the output is the input plus surgical edits,
// not a re-serialized DOM.
//
// Inline CSS is covered too: every `url(...)` inside a <style> element's text
// or a style="" attribute goes through the same asset() (the tokenizer is
// shared with css-urls.js), so a background image referenced from a hand-
// written stylesheet block is copied/inlined like an <img src> would be.
//
// Also extracts the document's <title> text so it can default the page's
// `title` (the .html analog of frontmatter title beating the name-derived
// default).

import { parse } from 'parse5';
import {
  ASSET_TAG_ATTRS,
  VALID_PLACEMENTS,
  classifyLinkRel,
} from './asset-rules.js';
import { findCssUrls } from './css-urls.js';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

function escAttrValue(s) {
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function findAttr(node, name) {
  return node.attrs.find((a) => a.name === name);
}

// The source span of an attribute (`name` or `name=value`), extended backward
// over the whitespace separating it from whatever precedes it (there is always
// at least one such character, so this can't eat into the tag name).
function attrSpanWithLeadingWs(source, loc) {
  let start = loc.startOffset;
  while (start > 0 && /\s/.test(source[start - 1])) start--;
  return { start, end: loc.endOffset };
}

// 1-based line/column of `offset` in `source`, for the call-site frame of a
// url() reference inside a <style> block (so the error points at the CSS
// line, not the <style> tag).
function lineColAt(source, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function processHtml(source, { asset, importerDisplay }) {
  const doc = parse(source, { sourceCodeLocationInfo: true });
  const edits = [];
  let title;

  // Rewrite every url(...) in a run of CSS text via asset(); returns the new
  // text, or null when nothing changed (every reference was passthrough).
  // `locAt(offset)` yields the {line, column} to report for a reference at
  // that offset of `css`.
  function rewriteInlineCss(css, { tag, placement, locAt }) {
    const refs = findCssUrls(css);
    if (refs.length === 0) return null;
    let out = '';
    let last = 0;
    let changed = false;
    for (const ref of refs) {
      const { line, column } = locAt(ref.start);
      const value = asset(ref.url, {
        placement,
        tag,
        locFile: importerDisplay,
        locLine: line,
        locColumn: column,
      });
      out += css.slice(last, ref.start);
      if (value === ref.url) {
        out += css.slice(ref.start, ref.end);
      } else {
        out += `url("${value}")`;
        changed = true;
      }
      last = ref.end;
    }
    out += css.slice(last);
    return changed ? out : null;
  }

  function processElement(node) {
    // Source spans only exist for tags that appear literally in the source
    // (parser-created elements carry no location); `attrs` is absent on an
    // element with no attributes.
    const loc = node.sourceCodeLocation;
    if (!loc) return;
    const attrLocs = loc.attrs ?? {};

    // Per-call placement override, extracted and removed like recma-assets
    // does at compile time (an invalid value is left alone and ships as-is).
    // Stays undefined when absent — asset() rejects any other non-placement.
    // Taken lazily so a `data-xtatic-placement` on an element that produces no
    // reference at all is left in place, but shared by every reference the
    // element does produce (whitelisted attrs, its style="", its CSS text).
    let placement;
    let placementTaken = false;
    function takePlacement() {
      if (placementTaken) return placement;
      placementTaken = true;
      const placementAttr = findAttr(node, 'data-xtatic-placement');
      if (
        placementAttr &&
        VALID_PLACEMENTS.has(placementAttr.value) &&
        attrLocs[placementAttr.name]
      ) {
        if (placementAttr.value !== 'auto') placement = placementAttr.value;
        const { start, end } = attrSpanWithLeadingWs(
          source,
          attrLocs[placementAttr.name],
        );
        edits.push({ start, end, text: '' });
      }
      return placement;
    }

    const attrs = ASSET_TAG_ATTRS[node.tagName];
    if (attrs) processWhitelistedAttrs(node, attrLocs, attrs, takePlacement);

    // style="…": the attribute is re-emitted double-quoted with the rewritten,
    // re-escaped CSS (parse5 hands over the entity-decoded value).
    const styleAttr = findAttr(node, 'style');
    const styleLoc = attrLocs.style;
    if (styleAttr && styleLoc) {
      const rewritten = rewriteInlineCss(styleAttr.value, {
        tag: node.tagName,
        placement: takePlacement(),
        locAt: () => ({ line: loc.startLine, column: loc.startCol }),
      });
      if (rewritten !== null) {
        edits.push({
          start: styleLoc.startOffset,
          end: styleLoc.endOffset,
          text: `style="${escAttrValue(rewritten)}"`,
        });
      }
    }

    // <style> text: operate on the raw source span, not the node's value —
    // parse5 normalizes CRLF in text, so offsets into the value wouldn't map
    // back onto the source.
    if (node.tagName === 'style') {
      for (const child of node.childNodes) {
        const tloc = child.sourceCodeLocation;
        if (child.nodeName !== '#text' || !tloc) continue;
        const css = source.slice(tloc.startOffset, tloc.endOffset);
        const rewritten = rewriteInlineCss(css, {
          tag: 'style',
          placement: takePlacement(),
          locAt: (offset) => lineColAt(source, tloc.startOffset + offset),
        });
        if (rewritten !== null) {
          edits.push({
            start: tloc.startOffset,
            end: tloc.endOffset,
            text: rewritten,
          });
        }
      }
    }
  }

  function processWhitelistedAttrs(node, attrLocs, attrs, takePlacement) {
    let kind = null;
    if (node.tagName === 'link') {
      const { isAsset, kind: k } = classifyLinkRel(findAttr(node, 'rel')?.value);
      if (!isAsset) return;
      kind = k;
    }
    // Whitelisted tags always consume the placement attr, even when every
    // value turns out to be passthrough (matches recma-assets).
    const placement = takePlacement();

    let rewrote = false;
    for (const attrName of attrs) {
      const attr = findAttr(node, attrName);
      const loc = attrLocs[attrName];
      if (!attr || !loc) continue;
      const value = asset(attr.value, {
        placement,
        kind,
        tag: node.tagName,
        locFile: importerDisplay,
        locLine: node.sourceCodeLocation.startLine,
        locColumn: node.sourceCodeLocation.startCol,
      });
      // Passthrough (external/data:/#…) values come back unchanged — keep the
      // original bytes. A rewritten value is an xtatic token (safe ASCII), and
      // is re-emitted double-quoted regardless of the source's quoting.
      if (value === attr.value) continue;
      edits.push({
        start: loc.startOffset,
        end: loc.endOffset,
        text: `${attrName}="${value}"`,
      });
      rewrote = true;
    }

    // The substitute pass that inlines a small stylesheet rewrites the whole
    // <link> to <style> by regex, stripping double-quoted rel="…"/href="…".
    // href is normalized above; normalize rel too in case the source had it
    // single-quoted or unquoted.
    if (rewrote && kind === 'stylesheet') {
      const relAttr = findAttr(node, 'rel');
      const relLoc = attrLocs[relAttr.name];
      if (relLoc) {
        edits.push({
          start: relLoc.startOffset,
          end: relLoc.endOffset,
          text: `rel="${escAttrValue(relAttr.value)}"`,
        });
      }
    }
  }

  function walk(node) {
    if (node.tagName) {
      processElement(node);
      if (
        title === undefined &&
        node.tagName === 'title' &&
        node.namespaceURI === HTML_NS
      ) {
        const text = node.childNodes
          .filter((c) => c.nodeName === '#text')
          .map((c) => c.value)
          .join('')
          .trim();
        if (text !== '') title = text;
      }
    }
    const children = node.content?.childNodes ?? node.childNodes ?? [];
    for (const child of children) walk(child);
  }

  walk(doc);

  edits.sort((a, b) => b.start - a.start);
  let html = source;
  for (const { start, end, text } of edits) {
    html = html.slice(0, start) + text + html.slice(end);
  }
  return { html, title };
}
