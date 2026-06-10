/**
 * Bright Data 客户端单元测试(SERP 使用 mock fetch,不调用真实 API)
 */
import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bigcms-bd-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { db } = await import('../src/db.js');
const {
  serpSearch,
  getBrightDataConfig,
  isSerpConfigured,
  getLocalBrowserPath,
  isLocalBrowserConfigured,
  isBrowserConfigured,
} = await import('../src/brightdata.js');

before(() => {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('brightdata_api_key', 'test-key');
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('brightdata_serp_zone', 'serp_zone_test');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('getBrightDataConfig 从 settings 读取 SERP 凭证', () => {
  const cfg = getBrightDataConfig();
  assert.equal(cfg.apiKey, 'test-key');
  assert.equal(cfg.serpZone, 'serp_zone_test');
  assert.equal(isSerpConfigured(cfg), true);
});

test('serpSearch 调用 Bright Data request 端点并解析 JSON', async () => {
  const original = globalThis.fetch;
  let captured: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ organic: [{ title: '示例', link: 'https://example.com' }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const data = (await serpSearch({ query: '企业 CMS', engine: 'google', hl: 'zh-CN', gl: 'cn' })) as {
      organic: { title: string }[];
    };
    assert.equal(captured?.url, 'https://api.brightdata.com/request');
    assert.equal((captured?.init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    const body = JSON.parse(String(captured?.init?.body));
    assert.equal(body.zone, 'serp_zone_test');
    assert.match(body.url, /google\.com\/search\?q=/);
    assert.equal(body.data_format, 'parsed_light');
    assert.equal(data.organic[0].title, '示例');
  } finally {
    globalThis.fetch = original;
  }
});

test('serpSearch 未配置时抛出明确错误', async () => {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run('brightdata_api_key');
  await assert.rejects(() => serpSearch({ query: 'x' }), /SERP API 未配置/);
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('brightdata_api_key', 'test-key');
});

test('getLocalBrowserPath 从 settings 读取本地浏览器路径', () => {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    'browser_executable_path',
    '/usr/bin/google-chrome'
  );
  assert.equal(getLocalBrowserPath(), '/usr/bin/google-chrome');
  assert.equal(isLocalBrowserConfigured(), true);
  assert.equal(isBrowserConfigured(), true);
  db.prepare(`DELETE FROM settings WHERE key = ?`).run('browser_executable_path');
});

test('browsePage 自定义浏览器路径不存在时抛出明确错误', async () => {
  const { browsePage } = await import('../src/brightdata.js');
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    'browser_executable_path',
    '/nonexistent/chrome'
  );
  try {
    await assert.rejects(() => browsePage({ url: 'https://example.com' }), /本地浏览器路径不存在/);
  } finally {
    db.prepare(`DELETE FROM settings WHERE key = ?`).run('browser_executable_path');
  }
});
