// A build-scoped stack of frames describing what's currently being rendered:
// which page, the layout chain wrapping it, and the component/module call sites
// in between. Rendering is fully synchronous (components are sync, the layout
// walk is sync), so a module-level stack is safe — nothing interleaves.
//
// The point is build-time error context. A `<Font text=…>` call records a job
// during render and returns immediately; the actual subsetting (and its "run
// npm install subset-font" failure) happens later in fontRegistry.processAll(),
// long after the render stack has unwound. So callers that defer work snapshot
// currentStack() onto their job and pass it back to attachContext() when the
// deferred work throws. For errors thrown synchronously during render, the live
// stack is attached at throw time (see jsxDEV / renderModule), so the deepest
// frame wins.

const stack = [];

export function pushFrame(frame) {
  stack.push(frame);
}

export function popFrame() {
  stack.pop();
}

// Run `fn` synchronously with `frame` pushed; pop it afterwards no matter what.
export function withFrame(frame, fn) {
  stack.push(frame);
  try {
    return fn();
  } finally {
    stack.pop();
  }
}

export function currentStack() {
  return stack.slice();
}

// Attach a context snapshot to `err` if it doesn't have one yet. Errors
// propagate outward, so the first writer — the deepest frame — wins. `frames`
// defaults to the live stack (for synchronous render errors); deferred work
// passes the snapshot it captured at job-creation time.
export function attachContext(err, frames = stack) {
  if (err && typeof err === 'object' && !err.xtaticContext) {
    try {
      err.xtaticContext = frames.slice();
    } catch {
      // err might be frozen; nothing to do.
    }
  }
  return err;
}

function fmtLoc(file, line, column) {
  if (!file) return '';
  let s = file;
  if (line != null) {
    s += `:${line}`;
    if (column != null) s += `:${column}`;
  }
  return s;
}

function fmtFrame(frame) {
  switch (frame.kind) {
    case 'page':
      return `while building page ${frame.page}`;
    case 'layout':
      return `in layout ${frame.file ?? '(layout)'}`;
    case 'module': {
      const at = fmtLoc(frame.atFile, frame.atLine, frame.atColumn);
      return at
        ? `in ${frame.file ?? '(module)'} (rendered at ${at})`
        : `in ${frame.file ?? '(module)'}`;
    }
    case 'component': {
      const tag = frame.name ? `<${frame.name}>` : '<component>';
      const at = fmtLoc(frame.atFile, frame.atLine, frame.atColumn);
      return at ? `in ${tag} at ${at}` : `in ${tag}`;
    }
    default:
      return JSON.stringify(frame);
  }
}

// Render a captured stack as indented lines, deepest first (like a JS stack
// trace). Returns '' for an empty/missing stack.
export function formatContext(frames) {
  if (!frames || frames.length === 0) return '';
  const lines = [];
  for (let i = frames.length - 1; i >= 0; i--) {
    lines.push(`  ${fmtFrame(frames[i])}`);
  }
  return lines.join('\n');
}
