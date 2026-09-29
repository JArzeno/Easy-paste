const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function timeLeft(ms) {
  const minutes = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Raster formats browsers render safely in an <img>. SVG is left out on purpose.
export const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

const LOGO = `<svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor"/><path d="M11 9.5h10a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H11A1.5 1.5 0 0 1 9.5 23V11A1.5 1.5 0 0 1 11 9.5Z" fill="none" stroke="#fff" stroke-width="2"/><path d="M13 14h6M13 17.5h6M13 21h3.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><rect x="12.5" y="7" width="7" height="4" rx="1.5" fill="#fff"/></svg>`;

export function layout({ title, description, body, script, footer = true }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
${script ? `<script src="${script}" defer></script>` : ''}
</head>
<body>
<main class="wrap">
  <header class="brand"><a href="/" class="logo">${LOGO}<span>Easy Paste</span></a></header>
${body}
${footer ? '  <footer class="foot"><a href="/">Share something yourself</a></footer>' : ''}
</main>
</body>
</html>`;
}

export function itemPage(meta, { text, now, ttlHours }) {
  const id = escapeHtml(meta.id);
  const expiresIso = new Date(meta.expiresAt).toISOString();
  const expiry = `<p class="muted expiry">Expires in <time datetime="${expiresIso}" data-expires>${timeLeft(meta.expiresAt - now)}</time></p>`;
  const description = `Shared with Easy Paste. Links expire in ${ttlHours} hours.`;

  if (meta.kind === 'text') {
    return layout({
      title: 'Shared text · Easy Paste',
      description,
      script: '/view.js',
      body: `  <section class="card">
    <div class="view-head">
      <h1>Shared text</h1>
      <span class="muted">${formatBytes(meta.size)}</span>
    </div>
    <pre class="paste" id="content">${escapeHtml(text)}</pre>
    <div class="actions">
      <button type="button" class="button primary" data-copy="content">Copy text</button>
      <a class="button" href="/${id}/download">Download .txt</a>
    </div>
    ${expiry}
  </section>`,
    });
  }

  const name = escapeHtml(meta.name);
  const ext = (meta.name.includes('.') ? meta.name.split('.').pop() : 'file').slice(0, 4).toUpperCase();
  const preview = PREVIEW_TYPES.has(meta.type)
    ? `<img class="preview" src="/${id}/raw" alt="Preview of ${name}">`
    : '';
  return layout({
    title: `${meta.name} · Easy Paste`,
    description,
    script: '/view.js',
    body: `  <section class="card">
    <div class="file-head">
      <div class="file-icon" aria-hidden="true">${escapeHtml(ext)}</div>
      <div class="file-meta">
        <h1 class="file-name">${name}</h1>
        <p class="muted">${formatBytes(meta.size)}</p>
      </div>
    </div>
    ${preview}
    <div class="actions">
      <a class="button primary" href="/${id}/download">Download</a>
    </div>
    ${expiry}
  </section>`,
  });
}

export function notFoundPage({ ttlHours }) {
  return layout({
    footer: false,
    title: 'Link expired · Easy Paste',
    description: 'This link has expired or does not exist.',
    body: `  <section class="card empty">
    <h1>This link has expired</h1>
    <p class="muted">Or it never existed. Shared items are deleted after ${ttlHours} hours.</p>
    <div class="actions"><a class="button primary" href="/">Share something new</a></div>
  </section>`,
  });
}
