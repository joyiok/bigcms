// 视觉验证脚本:对前台和后台关键页面截图(开发辅助,非业务代码)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const OUT = '/tmp/bigcms-shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'shell',
});
const page = await browser.newPage();

async function shot(name, url, { width = 1440, height = 900, fullPage = false, beforeLoad } = {}) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  if (beforeLoad) await beforeLoad();
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle0', timeout: 15000 });
  // hash 路由不会触发整页加载,统一 reload 保证 evaluateOnNewDocument 注入生效
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log(`${name}.png`);
}

// 前台
await shot('01-home', '/', { fullPage: true });
await shot('02-news', '/news', { fullPage: true });
await shot('03-detail', '/news/welcome-to-bigcms', { fullPage: true });
await shot('04-home-mobile', '/', { width: 390, height: 844, fullPage: true });

// 后台:登录页
await shot('05-admin-login', '/admin/');

// 后台:注入 token 后的各页面
const res = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token } = await res.json();
await page.evaluateOnNewDocument((t) => localStorage.setItem('bigcms_token', t), token);

await shot('06-admin-dashboard', '/admin/#/dashboard');
await shot('07-admin-articles', '/admin/#/articles');
await page.click('#btn-new').catch(() => {});
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: `${OUT}/08-admin-editor.png` });
console.log('08-admin-editor.png');
await shot('09-admin-users', '/admin/#/users');
await shot('10-admin-mobile', '/admin/#/articles', { width: 390, height: 844 });

await browser.close();
