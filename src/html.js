// Process a .html input file: parse with parse5 (source locations on), route
// every whitelisted (tag, attribute) reference through the per-importer
// asset() — the same runtime that recma-assets wires up for plain tags in
// .md/.mdx/.jsx — and splice the resulting tokens back into the original
// source text. Everything the parser didn't rewrite (whitespace, comments,
// doctype, attribute quoting, even markup the HTML algorithm would relocate)
// ships byte-identical, because the output is the input plus surgical edits,
// not a re-serialized DOM.
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

export function processHtml(source, { asset, importerDisplay }) {
  const doc = parse(source, { sourceCodeLocationInfo: true });
  const edits = [];
  let title;

  function processElement(node) {
    const attrs = ASSET_TAG_ATTRS[node.tagName];
    if (!attrs) return;
    // Attribute source spans only exist for tags that appear literally in the
    // source (parser-created elements carry no location).
    const attrLocs = node.sourceCodeLocation?.attrs;
    if (!attrLocs) return;

    let kind = null;
    if (node.tagName === 'link') {
      const { isAsset, kind: k } = classifyLinkRel(findAttr(node, 'rel')?.value);
      if (!isAsset) return;
      kind = k;
    }

    // Per-call placement override, extracted and removed like recma-assets
    // does at compile time (an invalid value is left alone and ships as-is).
    // Stays undefined when absent — asset() rejects any other non-placement.
    let placement;
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
