// Build-wide error collection for keep-going mode.
//
// A build normally stops at the first error. With `keepGoing`, each phase
// that can fail per unit of work (loading a page, expanding a generator,
// resolving a layout, rendering a page, processing an asset job) reports the
// error to this collector and moves on; whatever couldn't be produced is left
// out of the output, and the build ends by throwing one error that lists them
// all (see `build()` in index.js). In strict mode `report()` simply throws,
// so call sites read the same either way: `errors.report(e)` means "this unit
// failed" and the collector decides whether that ends the build.
//
// Errors are deduped by identity: a module that fails to compile is cached as
// failed by the registry and the same Error object is rethrown to every
// importer, so a broken layout imported by fifty pages is listed once.

export function createErrorCollector({ keepGoing = false } = {}) {
  const list = [];
  const seen = new Set();

  function add(err) {
    if (err !== null && typeof err === 'object') {
      if (seen.has(err)) return;
      seen.add(err);
    }
    list.push(err);
  }

  function report(err) {
    if (!keepGoing) throw err;
    add(err);
  }

  return {
    keepGoing,
    list,
    // Record without ever throwing — for the top-level catch that folds a
    // fatal error into the aggregate.
    add,
    // Record and continue (keepGoing) or throw (strict).
    report,
  };
}

function messageOf(err) {
  if (err !== null && typeof err === 'object' && typeof err.message === 'string') {
    return err.message;
  }
  return String(err);
}

// Compose the single error a keep-going build throws at the end: every
// collected error, numbered, plus the pages that were left out of the output.
// `skippedPages` is a list of page labels (logical paths).
export function makeBuildError(errors, skippedPages = []) {
  const n = errors.length;
  const parts = [`Build finished with ${n} error${n === 1 ? '' : 's'}:`];
  errors.forEach((err, i) => {
    const body = messageOf(err)
      .split('\n')
      .map((l, k) => (k === 0 || l === '' ? l : `    ${l}`))
      .join('\n');
    parts.push(`[${i + 1}/${n}] ${body}`);
  });
  if (skippedPages.length > 0) {
    const m = skippedPages.length;
    parts.push(
      `${m} page${m === 1 ? ' was' : 's were'} not written because of the errors above: ${skippedPages.join(', ')}`,
    );
  }
  const err = new AggregateError(errors, parts.join('\n\n'));
  err.xtaticKeepGoing = true;
  err.skippedPages = skippedPages;
  return err;
}

// Lint runs before the build and normally aborts on failure. Under keep-going
// the lint error is held back, the build runs anyway, and the two results are
// reported together: this joins whichever of them occurred (null for "none").
export function combineErrors(lintError, buildError) {
  if (lintError == null) return buildError ?? null;
  if (buildError == null) return lintError;
  const err = new AggregateError(
    [lintError, buildError],
    `${messageOf(lintError).replace(/\n+$/, '')}\n\n${messageOf(buildError)}`,
  );
  err.xtaticKeepGoing = true;
  return err;
}
