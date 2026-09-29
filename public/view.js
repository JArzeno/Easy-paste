(() => {
  const copyBtn = document.querySelector('[data-copy]');
  if (copyBtn) {
    const target = document.getElementById(copyBtn.dataset.copy);
    const label = copyBtn.textContent;
    let timer;
    copyBtn.addEventListener('click', async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(target.textContent);
        ok = true;
      } catch {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        try {
          ok = document.execCommand('copy');
        } catch {
          ok = false;
        }
      }
      copyBtn.textContent = ok ? 'Copied' : 'Copy manually';
      clearTimeout(timer);
      timer = setTimeout(() => {
        copyBtn.textContent = label;
      }, 1800);
    });
  }

  const expiresEl = document.querySelector('[data-expires]');
  if (expiresEl) {
    const expiresAt = new Date(expiresEl.getAttribute('datetime')).getTime();
    const tick = () => {
      const minutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60000));
      if (minutes === 0) {
        expiresEl.parentElement.textContent = 'This link has expired.';
        return;
      }
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      expiresEl.textContent = h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
      setTimeout(tick, 30000);
    };
    tick();
  }
})();
