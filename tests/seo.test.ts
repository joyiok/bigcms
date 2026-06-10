import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bigcms-seo-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { createApp } = await import('../src/app.js');
const { db, seed } = await import('../src/db.js');
const { ensureSiteCopySettings } = await import('../src/site-copy.js');
const { seoDescription, absoluteUrl } = await import('../src/seo.js');

const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;

before(async () => {
  seed();
  ensureSiteCopySettings(db);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('site_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    'https://www.example.com'
  );
  db.prepare(`INSERT INTO settings (key, value) VALUES ('site_logo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    '/uploads/logo.png'
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : 'http://127.0.0.1';
      resolve();
    });
  });
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function get(pathname: string) {
  const res = await fetch(`${base}${pathname}`);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

test('seoDescription 截断过长描述', () => {
  const long = 'a'.repeat(200);
  assert.equal(seoDescription(long).length, 160);
  assert.ok(seoDescription('短描述').endsWith('短描述'));
});

test('absoluteUrl 拼接相对路径', () => {
  assert.equal(absoluteUrl('https://www.example.com', '/news'), 'https://www.example.com/news');
});

test('首页包含 canonical、JSON-LD 与 Twitter 卡片', async () => {
  const { status, text } = await get('/');
  assert.equal(status, 200);
  assert.match(text, /<link rel="canonical" href="https:\/\/www\.example\.com\/">/);
  assert.match(text, /application\/ld\+json/);
  assert.match(text, /"@type":"Organization"/);
  assert.match(text, /"@type":"WebSite"/);
  assert.match(text, /twitter:card/);
  assert.match(text, /og:image.*logo\.png/);
});

test('sitemap 使用站点 URL 配置', async () => {
  const { status, text } = await get('/sitemap.xml');
  assert.equal(status, 200);
  assert.match(text, /<loc>https:\/\/www\.example\.com\/<\/loc>/);
  assert.match(text, /<changefreq>daily<\/changefreq>/);
});

test('搜索页 noindex', async () => {
  const { text } = await get('/news?q=test');
  assert.match(text, /<meta name="robots" content="noindex,follow">/);
});

test('robots.txt 指向配置的 sitemap', async () => {
  const { text } = await get('/robots.txt');
  assert.match(text, /Sitemap: https:\/\/www\.example\.com\/sitemap\.xml/);
});
