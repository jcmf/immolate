// Tiny console helpers shared by the watch/serve commands: a `[xtatic] `-prefixed
// logger and best-effort ANSI coloring. Color is active when stdout is a TTY or
// FORCE_COLOR is set (serve mode sets it so the browser error page gets ANSI),
// and never when NO_COLOR is set.

const PREFIX = '[xtatic] ';

const CODES = {
  red: 31,
  green: 32,
  yellow: 33,
  cyan: 36,
  dim: 2,
  bold: 1,
};

function colorEnabled() {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR != null) return process.env.FORCE_COLOR !== '0';
  return process.stdout.isTTY === true;
}

export function color(name, s) {
  const code = CODES[name];
  if (!code || !colorEnabled()) return String(s);
  return `\x1b[${code}m${s}\x1b[0m`;
}

export function log(msg) {
  console.log(PREFIX + msg);
}

export function warn(msg) {
  console.error(PREFIX + msg);
}

export function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
