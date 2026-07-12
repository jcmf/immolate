// The (tag, attribute) whitelist for automatic asset processing, shared by the
// two front ends that apply it — recma-assets.js (compile-time rewrite of JSX
// calls in .md/.mdx/.jsx) and html.js (parse5 walk over .html input files) —
// so the two can't drift.

export const ASSET_TAG_ATTRS = {
  img: ['src'],
  script: ['src'],
  source: ['src'],
  audio: ['src'],
  video: ['src', 'poster'],
  link: ['href'],
  a: ['href'],
  area: ['href'],
};

// <link> rel values whose href names a file to process. Non-asset rels
// (canonical, alternate, …) are skipped because their hrefs aren't files.
export const ASSET_LINK_RELS = new Set([
  'stylesheet',
  'icon',
  'shortcut',
  'apple-touch-icon',
  'apple-touch-icon-precomposed',
  'mask-icon',
  'preload',
  'prefetch',
  'modulepreload',
  'manifest',
]);

export const VALID_PLACEMENTS = new Set(['inline', 'shared', 'co-located', 'auto']);

// Classify a <link> element's literal rel string: is its href an asset to
// process, and if so is it a stylesheet (which gets the <link>→<style> inline
// rewrite)? A missing/unknowable rel is not an asset.
export function classifyLinkRel(rel) {
  if (typeof rel !== 'string') return { isAsset: false, kind: null };
  const tokens = rel.toLowerCase().split(/\s+/);
  return {
    isAsset: tokens.some((t) => ASSET_LINK_RELS.has(t)),
    kind: tokens.includes('stylesheet') ? 'stylesheet' : null,
  };
}
