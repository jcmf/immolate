import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { renderErrorPage } from './serve-error.js';
import { watch } from './watch.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

function isWithin(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

async function handle(outputDir, req, res, ctx) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(
      res,
      405,
      { 'content-type': 'text/plain; charset=utf-8' },
      'Method Not Allowed',
    );
  }
  // Hold the request until any in-progress (re)build settles — outputDir is
  // wiped and rewritten during a build, so serving mid-build means 404s or a
  // partial tree.
  if (ctx?.whenIdle) await ctx.whenIdle();
  if (ctx?.state?.error) {
    const { contentType, body } = await renderErrorPage(ctx.state.error, {
      topDir: ctx.topDir,
      errorLayout: ctx.errorLayout,
      reloadInterval: ctx.errorReloadInterval,
    });
    const headers = {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    };
    if (req.method === 'HEAD') {
      res.writeHead(503, headers);
      return res.end();
    }
    return send(res, 503, headers, body);
  }
  const parsed = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(parsed.pathname);
  const rel = pathname.replace(/^\/+/, '');
  const isDirRequest = pathname === '' || pathname.endsWith('/');
  const target = isDirRequest
    ? path.resolve(outputDir, rel, 'index.html')
    : path.resolve(outputDir, rel);
  if (!isWithin(outputDir, target)) {
    return send(
      res,
      400,
      { 'content-type': 'text/plain; charset=utf-8' },
      'Bad Request',
    );
  }
  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch {
    return send(
      res,
      404,
      { 'content-type': 'text/plain; charset=utf-8' },
      'Not Found',
    );
  }
  if (stat.isDirectory()) {
    return send(res, 301, { location: pathname + '/' + (parsed.search || '') }, '');
  }
  const headers = {
    'content-type': mimeFor(target),
    'content-length': stat.size,
    'cache-control': 'no-store',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  fs.createReadStream(target).pipe(res);
}

function openBrowser(url) {
  const p = process.platform;
  let cmd, args;
  if (p === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (p === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
  } catch {}
}

export async function serve({
  buildOptions,
  port = 3000,
  host = '127.0.0.1',
  open = false,
  errorLayout,
  errorReloadInterval = 2,
}) {
  if (process.env.FORCE_COLOR == null) process.env.FORCE_COLOR = '1';
  const { state, whenIdle } = await watch({ buildOptions });
  const ctx = {
    state,
    whenIdle,
    topDir: buildOptions.topDir,
    errorLayout,
    errorReloadInterval,
  };
  const server = http.createServer((req, res) => {
    handle(buildOptions.outputDir, req, res, ctx).catch((e) => {
      console.error(`[xtatic] server error: ${e.message}`);
      try {
        send(
          res,
          500,
          { 'content-type': 'text/plain; charset=utf-8' },
          'Internal Server Error',
        );
      } catch {}
    });
  });
  await new Promise((resolve, reject) => {
    function onError(e) {
      if (e.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} is already in use. Set XTATIC_PORT to a different value.`,
          ),
        );
      } else {
        reject(e);
      }
    }
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const addr = server.address();
  const url = `http://${addr.address}:${addr.port}/`;
  console.log(`[xtatic] serving ${url}`);
  if (open) {
    console.log(`[xtatic] opening ${url}`);
    if (!process.env.XTATIC_NO_OPEN) openBrowser(url);
  }
  return { server, url };
}
