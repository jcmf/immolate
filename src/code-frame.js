// Source-code frame rendering, shared by the lint phase (parse errors) and the
// render-context trace (build-time render errors). Given a source string and a
// 1-based line/column, it prints the offending line with ±2 lines of context,
// marking the error span — inline-highlighted when color is on, with a caret
// row when it's off. Long lines are windowed to `maxWidth` visible columns.

import { color, colorEnabled, highlight } from './log.js';

const ELLIPSIS = '…';

// Clip a long source line down to `maxWidth` visible columns. The error line is
// windowed *around* its span (so the offending region stays on screen even when
// it sits deep in a long line), with `…` markers on whichever ends were cut;
// context lines are left-anchored (we keep their start). `maxWidth` of 0 (or a
// line already within budget) means no clipping. Returns the visible body plus
// the span's offset/length within it (clamped to the window) for the caller to
// place the caret or the highlight. `start` is the 0-indexed span column.
function windowLine(text, maxWidth, start, len) {
  if (!maxWidth || text.length <= maxWidth) {
    return { body: text, spanStart: start, spanLen: len };
  }
  if (start == null) {
    // Context line: keep the head, mark the tail as cut.
    return { body: text.slice(0, maxWidth) + ELLIPSIS, spanStart: null, spanLen: 0 };
  }
  // Center the window on the span, clamped within the line, then pin to the
  // right edge if centering ran past end-of-line so we always use the full width.
  const anchor = Math.min(start, text.length);
  let winStart = Math.max(0, anchor - Math.floor((maxWidth - Math.min(len, maxWidth)) / 2));
  let winEnd = Math.min(text.length, winStart + maxWidth);
  winStart = Math.max(0, winEnd - maxWidth);
  const prefix = winStart > 0 ? ELLIPSIS : '';
  const suffix = winEnd < text.length ? ELLIPSIS : '';
  const body = prefix + text.slice(winStart, winEnd) + suffix;
  const spanStart = prefix.length + (start - winStart);
  // Clip the span to what's visible in the window (it may extend past winEnd).
  const spanLen = Math.min(len, body.length - suffix.length - spanStart);
  return { body, spanStart, spanLen };
}

// When color is on, the offending span is highlighted inline on the source line
// itself (self-locating — it survives soft-wrapping of a long line, unlike a
// caret on a separate row). When color is off (NO_COLOR, piped output, CI), we
// fall back to the classic caret row so plain-text consumers still get a marker.
// Lines wider than `maxWidth` are windowed first (see windowLine).
export function renderCodeFrame(source, line, column, endLine, endColumn, maxWidth = 0) {
  const lines = source.split('\n');
  if (line < 1 || line > lines.length) return '';
  const first = Math.max(1, line - 2);
  const last = Math.min(lines.length, line + 2);
  const gutter = String(last).length;
  const useColor = colorEnabled();
  const out = [];
  for (let i = first; i <= last; i++) {
    const isErr = i === line;
    const marker = isErr ? '> ' : '  ';
    const num = String(i).padStart(gutter);
    if (isErr && column) {
      const len = endLine === line && endColumn && endColumn > column
        ? endColumn - column
        : 1;
      const w = windowLine(lines[i - 1], maxWidth, column - 1, len);
      const start = w.spanStart;
      if (useColor) {
        const before = w.body.slice(0, start);
        // An empty slice means the error sits past end-of-line; paint one space
        // so there's still a visible block (the caret row had the same fudge).
        const span = w.body.slice(start, start + Math.max(1, w.spanLen)) || ' ';
        const after = w.body.slice(start + Math.max(1, w.spanLen));
        out.push(`${color('red', `${marker}${num}`)} | ${before}${highlight(span)}${after}`);
      } else {
        out.push(`${marker}${num} | ${w.body}`);
        out.push(`  ${' '.repeat(gutter)} | ${' '.repeat(start)}${'^'.repeat(Math.max(1, w.spanLen))}`);
      }
    } else {
      out.push(`${marker}${num} | ${windowLine(lines[i - 1], maxWidth).body}`);
    }
  }
  return out.join('\n');
}
