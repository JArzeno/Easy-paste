(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.querySelector('main');
  const maxFileBytes = Number(root.dataset.maxFileBytes);
  const maxTextBytes = Number(root.dataset.maxTextBytes);
  const ttlHours = root.dataset.ttlHours;

  const form = $('form');
  const textEl = $('text');
  const fileEl = $('file');
  const submitBtn = $('submit');
  const errorEl = $('error');
  const composer = $('composer');
  const result = $('result');
  const linkEl = $('link');
  const copyBtn = $('copy');
  const shareBtn = $('share');

  let mode = 'text';
  let pickedFile = null;

  function formatBytes(bytes) {
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

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.hidden = true;
  }

  function setMode(next) {
    mode = next;
    $(`mode-${next}`).checked = true;
    document.querySelectorAll('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== next;
    });
    clearError();
  }

  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      setMode(radio.value);
      if (radio.value === 'text') textEl.focus();
    });
  });

  function pickFile(file) {
    if (!file) return;
    pickedFile = file;
    $('picked-name').textContent = file.name || 'Pasted file';
    $('picked-size').textContent = formatBytes(file.size);
    $('drop-empty').hidden = true;
    $('drop-picked').hidden = false;
    clearError();
    if (file.size > maxFileBytes) showError(`This file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxFileBytes)}.`);
  }

  fileEl.addEventListener('change', () => pickFile(fileEl.files[0]));

  // Drop a file anywhere on the page.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    setMode('file');
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    pickFile(e.dataTransfer.files[0]);
  });

  // Paste a file or screenshot anywhere. Plain text pastes go to the textbox as usual.
  document.addEventListener('paste', (e) => {
    if (!result.hidden) return;
    const data = e.clipboardData;
    if (!data || !data.files || data.files.length === 0) return;
    const hasText = Array.from(data.types).includes('text/plain');
    if (mode === 'text' && hasText) return;
    e.preventDefault();
    setMode('file');
    pickFile(data.files[0]);
  });

  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  });

  function upload(url, body, headers, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.responseType = 'json';
      Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
      xhr.addEventListener('load', () => {
        const data = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || 'Something went wrong. Please try again.'));
      });
      xhr.addEventListener('error', () => reject(new Error('Upload failed. Check your connection and try again.')));
      xhr.send(body);
    });
  }

  function setBusy(busy, label) {
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? label : 'Create link';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitBtn.disabled) return;
    clearError();

    let request;
    if (mode === 'text') {
      const text = textEl.value;
      if (!text.trim()) {
        textEl.focus();
        return showError('Paste or type something first.');
      }
      if (new Blob([text]).size > maxTextBytes) return showError(`That text is too long. The limit is ${formatBytes(maxTextBytes)}.`);
      request = ['/api/text', text, { 'Content-Type': 'text/plain; charset=utf-8' }];
    } else {
      if (!pickedFile) return showError('Choose a file first.');
      if (pickedFile.size === 0) return showError('That file is empty.');
      if (pickedFile.size > maxFileBytes) return showError(`This file is ${formatBytes(pickedFile.size)}. The limit is ${formatBytes(maxFileBytes)}.`);
      request = ['/api/file', pickedFile, {
        'Content-Type': pickedFile.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(pickedFile.name || 'file'),
      }];
    }

    setBusy(true, mode === 'file' ? 'Uploading...' : 'Creating link...');
    try {
      const data = await upload(...request, (fraction) => {
        if (mode === 'file') setBusy(true, fraction < 1 ? `Uploading ${Math.round(fraction * 100)}%` : 'Creating link...');
      });
      showResult(data);
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
    }
  });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      linkEl.focus();
      linkEl.select();
      try {
        return document.execCommand('copy');
      } catch {
        return false;
      }
    }
  }

  function flash(button, label) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = label;
    clearTimeout(button._timer);
    button._timer = setTimeout(() => {
      button.textContent = original;
    }, 1800);
  }

  function showResult(data) {
    const url = `${location.origin}${data.path}`;
    const expires = new Date(data.expiresAt);
    linkEl.value = url;
    $('open').href = url;
    $('expires').textContent = `Expires in ${ttlHours} hours (${expires.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}). Anyone with the link can open it.`;
    shareBtn.hidden = typeof navigator.share !== 'function';
    composer.hidden = true;
    result.hidden = false;
    linkEl.focus();
    linkEl.select();
    navigator.clipboard?.writeText(url).then(() => flash(copyBtn, 'Copied'), () => {});
  }

  copyBtn.addEventListener('click', async () => {
    flash(copyBtn, (await copyText(linkEl.value)) ? 'Copied' : 'Copy manually');
  });

  linkEl.addEventListener('focus', () => linkEl.select());

  shareBtn.addEventListener('click', () => {
    navigator.share({ title: 'Easy Paste', url: linkEl.value }).catch(() => {});
  });

  $('again').addEventListener('click', () => {
    form.reset();
    pickedFile = null;
    $('drop-empty').hidden = false;
    $('drop-picked').hidden = true;
    result.hidden = true;
    composer.hidden = false;
    setMode(mode);
    if (mode === 'text') textEl.focus();
  });
})();
