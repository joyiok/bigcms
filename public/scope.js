/* 首页 hero:轻量等高线动画(蓝绿品牌色,装饰用) */
(() => {
  'use strict';
  const canvas = document.getElementById('scope');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let w = 0, h = 0, dpr = 1;
  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  addEventListener('resize', resize);

  const BLUE = 'rgba(12, 115, 223';
  const GREEN = 'rgba(70, 194, 95';
  const waves = [
    { color: BLUE, amp: 0.1, freq: 0.0038, speed: 0.005, width: 1.4, alpha: 0.2, y: 0.72 },
    { color: GREEN, amp: 0.08, freq: 0.0058, speed: -0.0035, width: 1.1, alpha: 0.14, y: 0.78 },
    { color: BLUE, amp: 0.13, freq: 0.0026, speed: 0.0022, width: 1, alpha: 0.08, y: 0.68 },
  ];

  function drawWave(wave, t) {
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const envelope = Math.sin((x / w) * Math.PI);
      const y = h * wave.y
        + Math.sin(x * wave.freq + t * wave.speed * 60) * h * wave.amp * envelope
        + Math.sin(x * wave.freq * 2.7 + t * wave.speed * 90) * h * wave.amp * 0.3 * envelope;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `${wave.color}, ${wave.alpha})`;
    ctx.lineWidth = wave.width;
    ctx.stroke();
  }

  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    for (const wave of waves) drawWave(wave, t / 1000);
  }

  if (reduced) {
    frame(4200);
  } else {
    const loop = (t) => { frame(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
})();
