/* 前台主题切换 · 与 VI 门户一致 */
(() => {
  'use strict';
  const root = document.documentElement;
  const btn = document.getElementById('themeToggle');
  if (!btn) return;

  const stored = localStorage.getItem('bigcms-theme');
  if (stored === 'light' || stored === 'dark') {
    root.setAttribute('data-theme', stored);
  }

  function syncIcon() {
    const dark = root.getAttribute('data-theme') !== 'light';
    btn.querySelector('.icon-sun')?.toggleAttribute('hidden', dark);
    btn.querySelector('.icon-moon')?.toggleAttribute('hidden', !dark);
  }

  syncIcon();

  btn.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    localStorage.setItem('bigcms-theme', next);
    syncIcon();
  });
})();
