document.getElementById('contact-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('[type=submit]');
  const msg = document.getElementById('contact-msg');
  const body = Object.fromEntries(new FormData(form));
  btn.disabled = true;
  msg.hidden = true;
  try {
    const res = await fetch('/api/public/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '提交失败');
    form.reset();
    msg.textContent = form.dataset.success || '提交成功';
    msg.className = 'contact-msg ok';
    msg.hidden = false;
  } catch (err) {
    msg.textContent = err.message || '提交失败';
    msg.className = 'contact-msg err';
    msg.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
