import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createStore, TooLargeError, EmptyError } from './store.js';
import { itemPage, notFoundPage, formatBytes, PREVIEW_TYPES } from './pages.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const HOUR = 60 * 60 * 1000;

const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/view.js': ['view.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// User content is never allowed to run as a page on this origin.
const CONTENT_CSP = "default-src 'none'; sandbox";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createRateLimiter(max, windowMs, now) {
  const hits = new Map();
  return {
    take(key) {
      if (!max) return true;
      const t = now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      return entry.count <= max;
    },
    sweep() {
      const t = now();
      for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
    },
  };
}

function cleanFileName(raw) {
  let name = '';
  try {
    name = decodeURIComponent(raw || '');
  } catch {
    name = '';
  }
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 200);
  return name || 'file';
}

function cleanType(raw) {
  const type = String(raw || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream';
}

function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function createApp(options = {}) {
  const now = options.now ?? Date.now;
  const config = {
    dataDir: options.dataDir ?? './data',
    ttlMs: options.ttlMs ?? 24 * HOUR,
    maxFileBytes: options.maxFileBytes ?? 25 * 1024 * 1024,
    maxTextBytes: options.maxTextBytes ?? 1024 * 1024,
    rateLimit: options.rateLimit ?? 60,
    trustProxy: options.trustProxy ?? false,
    cleanupIntervalMs: options.cleanupIntervalMs ?? 10 * 60 * 1000,
  };
  const ttlHours = Math.round((config.ttlMs / HOUR) * 10) / 10;

  const store = createStore({ dataDir: config.dataDir, ttlMs: config.ttlMs, now });
  await store.init();
  await store.cleanup();

  const limiter = createRateLimiter(config.rateLimit, HOUR, now);

  const assets = {};
  for (const [route, [file, type]] of Object.entries(ASSETS)) {
    let body = await fsp.readFile(path.join(PUBLIC_DIR, file), 'utf8');
    if (file === 'index.html') {
      body = body
        .replaceAll('{{maxFileBytes}}', String(config.maxFileBytes))
        .replaceAll('{{maxTextBytes}}', String(config.maxTextBytes))
        .replaceAll('{{maxFileSize}}', formatBytes(config.maxFileBytes))
        .replaceAll('{{ttlHours}}', String(ttlHours));
    }
    assets[route] = { body: Buffer.from(body), type };
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    });
    res.end(body);
  }

  function sendPage(res, status, html) {
    send(res, status, html, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    });
  }

  function sendJson(res, status, data) {
    send(res, status, JSON.stringify(data), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  function checkUpload(req, maxBytes, label) {
    if (!limiter.take(clientIp(req))) {
      throw new HttpError(429, 'Too many uploads. Please wait a bit and try again.');
    }
    const length = Number(req.headers['content-length']);
    if (length > maxBytes) throw new HttpError(413, `${label} is too large. The limit is ${formatBytes(maxBytes)}.`);
  }

  async function saveUpload(req, res, item, maxBytes, label) {
    let meta;
    try {
      meta = await store.put({ ...item, source: req, maxBytes });
    } catch (err) {
      if (err instanceof TooLargeError) throw new HttpError(413, `${label} is too large. The limit is ${formatBytes(maxBytes)}.`);
      if (err instanceof EmptyError) throw new HttpError(400, item.kind === 'text' ? 'There is no text to share.' : 'That file is empty.');
      throw err;
    }
    sendJson(res, 201, {
      id: meta.id,
      path: `/${meta.id}`,
      kind: meta.kind,
      size: meta.size,
      expiresAt: new Date(meta.expiresAt).toISOString(),
    });
  }

  async function serveContent(req, res, meta, mode) {
    const isText = meta.kind === 'text';
    const name = isText ? `easy-paste-${meta.id}.txt` : meta.name;
    const type = isText ? 'text/plain; charset=utf-8' : meta.type;
    const inline = mode === 'raw' && (isText || PREVIEW_TYPES.has(meta.type));
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': meta.size,
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
      'Content-Security-Policy': CONTENT_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    if (req.method === 'HEAD') return res.end();
    try {
      await pipeline(store.readStream(meta.id), res);
    } catch {
      res.destroy();
    }
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method;

    if (method === 'GET' || method === 'HEAD') {
      const asset = assets[pathname];
      if (asset) {
        return send(res, 200, asset.body, {
          'Content-Type': asset.type,
          'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=300',
          ...(asset.type.startsWith('text/html') ? { 'Content-Security-Policy': PAGE_CSP } : {}),
        });
      }
      if (pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

      const match = pathname.match(/^\/([A-Za-z0-9]{10})(?:\/(raw|download))?\/?$/);
      if (match) {
        const [, id, mode] = match;
        const meta = await store.get(id);
        if (!meta) return sendPage(res, 404, notFoundPage({ ttlHours }));
        if (mode) return serveContent(req, res, meta, mode);
        const text = meta.kind === 'text' ? await store.readText(id) : null;
        return sendPage(res, 200, itemPage(meta, { text, now: now(), ttlHours }));
      }
      return sendPage(res, 404, notFoundPage({ ttlHours }));
    }

    if (method === 'POST' && pathname === '/api/text') {
      checkUpload(req, config.maxTextBytes, 'Text');
      return saveUpload(req, res, { kind: 'text', type: 'text/plain' }, config.maxTextBytes, 'Text');
    }

    if (method === 'POST' && pathname === '/api/file') {
      checkUpload(req, config.maxFileBytes, 'File');
      const item = {
        kind: 'file',
        name: cleanFileName(req.headers['x-file-name']),
        type: cleanType(req.headers['content-type']),
      };
      return saveUpload(req, res, item, config.maxFileBytes, 'File');
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });
    return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD, POST' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.destroy();
      const message = status === 500 ? 'Something went wrong. Please try again.' : err.message;
      if (req.url.startsWith('/api/')) {
        // Close instead of draining a body we are refusing.
        res.setHeader('Connection', 'close');
        sendJson(res, status, { error: message });
      } else {
        send(res, status, message, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
    });
  });

  const timer = setInterval(() => {
    limiter.sweep();
    store.cleanup().catch((err) => console.error('cleanup failed', err));
  }, config.cleanupIntervalMs);
  timer.unref();
  server.on('close', () => clearInterval(timer));

  return { server, store, config };
}
