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

/* 移动端导航菜单 */
(() => {
  'use strict';
  const btn = document.getElementById('navToggle');
  const nav = document.getElementById('siteNav');
  if (!btn || !nav) return;

  function setOpen(open) {
    nav.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
    btn.querySelector('.icon-menu')?.toggleAttribute('hidden', open);
    btn.querySelector('.icon-close')?.toggleAttribute('hidden', !open);
  }

  btn.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
  document.addEventListener('click', (e) => {
    if (!nav.classList.contains('open')) return;
    if (e.target.closest('#siteNav') || e.target.closest('#navToggle')) return;
    setOpen(false);
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 880) setOpen(false);
  });
})();
