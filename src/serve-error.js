import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ANSI_RE = /\x1b\[([\d;]*)m/g;

const FG = {
  30: '#000', 31: '#cd3131', 32: '#0dbc79', 33: '#e5e510',
  34: '#2472c8', 35: '#bc3fbc', 36: '#11a8cd', 37: '#e5e5e5',
  90: '#666', 91: '#f14c4c', 92: '#23d18b', 93: '#f5f543',
  94: '#3b8eea', 95: '#d670d6', 96: '#29b8db', 97: '#fff',
};

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

export function ansiToHtml(s) {
  const src = String(s);
  let out = '';
  let pos = 0;
  let spanOpen = false;
  let state = { fg: null, bold: false, dim: false, underline: false };
  function styleStr() {
    const a = [];
    if (state.fg) a.push(`color:${state.fg}`);
    if (state.bold) a.push('font-weight:bold');
    if (state.dim) a.push('opacity:0.65');
    if (state.underline) a.push('text-decoration:underline');
    return a.join(';');
  }
  function flushOpen() {
    if (spanOpen) { out += '</span>'; spanOpen = false; }
    const css = styleStr();
    if (css) { out += `<span style="${css}">`; spanOpen = true; }
  }
  ANSI_RE.lastIndex = 0;
  let m;
  while ((m = ANSI_RE.exec(src)) !== null) {
    out += escHtml(src.slice(pos, m.index));
    pos = ANSI_RE.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(';').map((x) => Number(x));
    for (const c of codes) {
      if (c === 0) state = { fg: null, bold: false, dim: false, underline: false };
      else if (c === 1) state.bold = true;
      else if (c === 2) state.dim = true;
      else if (c === 4) state.underline = true;
      else if (c === 22) { state.bold = false; state.dim = false; }
      else if (c === 24) state.underline = false;
      else if (c === 39) state.fg = null;
      else if (FG[c]) state.fg = FG[c];
    }
    flushOpen();
  }
  out += escHtml(src.slice(pos));
  if (spanOpen) out += '</span>';
  return out;
}

function builtinTemplate({ errorHtml, reloadInterval, layoutNote }) {
  const meta = reloadInterval > 0
    ? `<meta http-equiv="refresh" content="${reloadInterval}">`
    : '';
  const note = reloadInterval > 0
    ? `<p class="note">This page reloads every ${reloadInterval}s while the build is broken.</p>`
    : '';
  const layoutNoteHtml = layoutNote
    ? `<p class="note">errorLayout failed to render: ${escHtml(layoutNote)}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Build error · xtatic</title>
${meta}
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #1e1e1e; color: #d4d4d4; margin: 0; padding: 1.5rem 2rem;
    line-height: 1.5; font-size: 13px; }
  h1 { color: #f14c4c; font-size: 1rem; margin: 0 0 1rem; font-weight: 600; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0;
    font-family: inherit; font-size: inherit; }
  .note { color: #888; font-size: 0.85rem; margin: 1.5rem 0 0; }
</style>
</head>
<body>
<h1>xtatic build failed</h1>
<pre>${errorHtml}</pre>
${layoutNoteHtml}
${note}
</body>
</html>
`;
}

export async function renderErrorPage(error, opts = {}) {
  const { topDir, errorLayout, reloadInterval = 2 } = opts;
  const raw = error?.stack ?? error?.message ?? String(error);
  const errorHtml = ansiToHtml(raw);
  const errorText = stripAnsi(raw);
  const props = { error, errorHtml, errorText, reloadInterval };

  let layoutNote = null;
  if (errorLayout) {
    try {
      const abs = path.isAbsolute(errorLayout)
        ? errorLayout
        : path.resolve(topDir ?? '.', errorLayout);
      const mod = await import(pathToFileURL(abs).href);
      const fn = mod.default ?? mod;
      if (typeof fn !== 'function') {
        throw new Error('errorLayout default export is not a function');
      }
      const html = await fn(props);
      if (typeof html !== 'string') {
        throw new Error(`errorLayout returned ${typeof html}, expected string`);
      }
      return { contentType: 'text/html; charset=utf-8', body: html };
    } catch (e) {
      layoutNote = e.message;
    }
  }

  try {
    const html = builtinTemplate({ errorHtml, reloadInterval, layoutNote });
    return { contentType: 'text/html; charset=utf-8', body: html };
  } catch {
    return { contentType: 'text/plain; charset=utf-8', body: errorText };
  }
}
