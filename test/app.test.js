import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../lib/app.js';

const HOUR = 60 * 60 * 1000;
let clock = Date.now();
let dataDir;
let server;
let base;

before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'easy-paste-'));
  ({ server } = await createApp({
    dataDir,
    now: () => clock,
    maxFileBytes: 1024,
    maxTextBytes: 512,
    rateLimit: 0,
  }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const postText = (text) => fetch(`${base}/api/text`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain' } });
const postFile = (body, name, type = 'application/octet-stream') =>
  fetch(`${base}/api/file`, { method: 'POST', body, headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) } });

test('home page renders with limits filled in', async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /How it works/);
  assert.match(html, /data-max-file-bytes="1024"/);
  assert.doesNotMatch(html, /\{\{/);
  assert.ok(res.headers.get('content-security-policy'));
});

test('shares text and shows it escaped', async () => {
  const text = '<script>alert(1)</script>\nsecond line';
  const res = await postText(text);
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.match(data.id, /^[A-Za-z0-9]{10}$/);
  assert.equal(data.path, `/${data.id}`);
  assert.ok(Date.parse(data.expiresAt) - clock === 24 * HOUR);

  const page = await fetch(`${base}${data.path}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  const html = await page.text();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);

  const raw = await fetch(`${base}${data.path}/raw`);
  assert.equal(await raw.text(), text);
  assert.match(raw.headers.get('content-type'), /^text\/plain/);
  assert.match(raw.headers.get('content-security-policy'), /sandbox/);
});

test('rejects empty and oversized text', async () => {
  assert.equal((await postText('')).status, 400);
  const big = await postText('x'.repeat(513));
  assert.equal(big.status, 413);
  assert.match((await big.json()).error, /too large/);
});

test('shares a file and downloads it as an attachment', async () => {
  const body = Buffer.from([0, 1, 2, 3, 250, 251]);
  const res = await postFile(body, 'report final.pdf', 'application/pdf');
  assert.equal(res.status, 201);
  const { id } = await res.json();

  const page = await (await fetch(`${base}/${id}`)).text();
  assert.match(page, /report final\.pdf/);
  assert.match(page, new RegExp(`href="/${id}/download"`));

  const dl = await fetch(`${base}/${id}/download`);
  assert.equal(dl.status, 200);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), body);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="report final\.pdf"/);
});

test('never serves uploaded HTML or SVG inline', async () => {
  for (const [name, type] of [['x.html', 'text/html'], ['x.svg', 'image/svg+xml']]) {
    const { id } = await (await postFile('<script>alert(1)</script>', name, type)).json();
    const raw = await fetch(`${base}/${id}/raw`);
    assert.match(raw.headers.get('content-disposition'), /^attachment/);
    assert.match(raw.headers.get('content-security-policy'), /sandbox/);
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('shows an inline preview for images', async () => {
  const { id } = await (await postFile(Buffer.from('fakepng'), 'shot.png', 'image/png')).json();
  const html = await (await fetch(`${base}/${id}`)).text();
  assert.match(html, new RegExp(`<img class="preview" src="/${id}/raw"`));
  const raw = await fetch(`${base}/${id}/raw`);
  assert.match(raw.headers.get('content-disposition'), /^inline/);
});

test('handles unicode and unsafe file names', async () => {
  const { id } = await (await postFile('hi', '../../fotos/año "nuevo".txt')).json();
  const dl = await fetch(`${base}/${id}/download`);
  const disposition = dl.headers.get('content-disposition');
  assert.match(disposition, /filename="\.\.\.\.fotosa_o _nuevo_\.txt"/);
  assert.match(disposition, /filename\*=UTF-8''\.\.\.\.fotosa%C3%B1o%20%22nuevo%22\.txt/);
});

test('rejects files over the limit', async () => {
  const res = await postFile(Buffer.alloc(2048), 'big.bin');
  assert.equal(res.status, 413);
  assert.equal(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('unknown and malformed links show the expired page', async () => {
  for (const p of ['/abcdefghij', '/nope', '/abcdefghij/download', '/../etc/passwd']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, p);
    assert.match(await res.text(), /expired/);
  }
});

test('items expire after 24 hours and get cleaned up', async () => {
  const { id } = await (await postText('temporary')).json();
  assert.equal((await fetch(`${base}/${id}`)).status, 200);

  clock += 24 * HOUR - 1000;
  assert.equal((await fetch(`${base}/${id}`)).status, 200);

  clock += 2000;
  assert.equal((await fetch(`${base}/${id}`)).status, 404);
  assert.equal((await fetch(`${base}/${id}/raw`)).status, 404);
  assert.ok(!fs.existsSync(path.join(dataDir, `${id}.json`)));
  assert.ok(!fs.existsSync(path.join(dataDir, `${id}.bin`)));
});

test('cleanup removes expired items without them being opened', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'easy-paste-'));
  let t = Date.now();
  const { store } = await createApp({ dataDir: dir, now: () => t });
  const { Readable } = await import('node:stream');
  await store.put({ kind: 'text', type: 'text/plain', source: Readable.from([Buffer.from('a')]), maxBytes: 10 });
  assert.equal(fs.readdirSync(dir).length, 2);
  t += 25 * HOUR;
  assert.equal(await store.cleanup(), 1);
  assert.equal(fs.readdirSync(dir).length, 0);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('rate limits uploads per IP', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'easy-paste-'));
  const { server: limited } = await createApp({ dataDir: dir, rateLimit: 2 });
  await new Promise((resolve) => limited.listen(0, resolve));
  const url = `http://127.0.0.1:${limited.address().port}/api/text`;
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await fetch(url, { method: 'POST', body: 'hi' })).status);
  assert.deepEqual(statuses, [201, 201, 429]);
  await new Promise((resolve) => limited.close(resolve));
  await fsp.rm(dir, { recursive: true, force: true });
});
