/**
 * API 集成测试:在临时目录起一套真实应用(独立 SQLite),用 fetch 直接打 HTTP。
 * 运行:npm test
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

// 必须在导入业务代码之前设置:db.ts 在导入时即按环境变量建库
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bigcms-test-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { createApp } = await import('../src/app.js');
const { seed } = await import('../src/db.js');
const { publishDue } = await import('../src/scheduler.js');

let server: Server;
let base = '';
let adminToken = '';

interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  headers: Headers;
}

async function api(
  p: string,
  opts: { method?: string; token?: string; body?: unknown; raw?: BodyInit } = {}
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : opts.raw,
  });
  return { status: res.status, data: await res.clone().json().catch(() => null), headers: res.headers };
}

async function login(username: string, password: string): Promise<ApiResult> {
  return api('/api/auth/login', { method: 'POST', body: { username, password } });
}

before(async () => {
  seed();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('监听失败');
  base = `http://127.0.0.1:${address.port}`;
  adminToken = (await login('admin', 'admin123')).data.token;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('登录:成功返回 token,密码错误 401', async () => {
  const ok = await login('admin', 'admin123');
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  assert.equal(ok.data.user.role, 'admin');

  const bad = await login('admin', 'wrong-password');
  assert.equal(bad.status, 401);
});

test('登录限速:同一账号 10 次失败后返回 429,并留失败审计', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await login('nobody', 'x');
    assert.equal(r.status, 401);
  }
  const blocked = await login('nobody', 'x');
  assert.equal(blocked.status, 429);

  const logs = await api('/api/audit-logs?action=login_failed', { token: adminToken });
  assert.equal(logs.status, 200);
  assert.ok(logs.data.total >= 10);
  assert.equal(logs.data.items[0].username, 'nobody');
});

test('认证与权限:未登录 401,只读角色建文章 403', async () => {
  assert.equal((await api('/api/articles')).status, 401);

  const created = await api('/api/users', {
    method: 'POST',
    token: adminToken,
    body: { username: 'watcher', email: 'watcher@test.local', password: 'watch123', role: 'viewer' },
  });
  assert.equal(created.status, 201);

  const viewerToken = (await login('watcher', 'watch123')).data.token;
  assert.equal((await api('/api/articles', { token: viewerToken })).status, 200);
  const denied = await api('/api/articles', { method: 'POST', token: viewerToken, body: { title: 'x' } });
  assert.equal(denied.status, 403);
});

test('站点设置:AI API Key 只返回已配置标记,不回显密钥', async () => {
  const saved = await api('/api/settings', {
    method: 'PUT',
    token: adminToken,
    body: { ai_provider: 'deepseek', ai_model: 'deepseek-v4-flash', ai_thinking: 'off', ai_api_key: 'sk-test-secret' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.ai_provider, 'deepseek');
  assert.equal(saved.data.ai_model, 'deepseek-v4-flash');
  assert.equal(saved.data.ai_api_key_set, '1');
  assert.equal(saved.data.ai_api_key, undefined);

  const fetched = await api('/api/settings', { token: adminToken });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.ai_api_key_set, '1');
  assert.equal(fetched.data.ai_api_key, undefined);

  const cleared = await api('/api/settings', { method: 'PUT', token: adminToken, body: { ai_api_key_clear: '1' } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.ai_api_key_set, '');
  assert.equal(cleared.data.ai_api_key, undefined);
});

test('文章:slug 冲突返回 409', async () => {
  const dup = await api('/api/articles', {
    method: 'POST',
    token: adminToken,
    body: { title: '冲突测试', slug: 'welcome-to-bigcms' },
  });
  assert.equal(dup.status, 409);
});

test('定时发布:到期草稿被调度器转为已发布', async () => {
  const created = await api('/api/articles', {
    method: 'POST',
    token: adminToken,
    body: { title: '定时发布测试', slug: 'scheduled-test', status: 'draft', scheduled_at: '2020-01-01T00:00:00Z' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.scheduled_at, '2020-01-01 00:00:00');

  let pub = await api('/api/public/articles/scheduled-test');
  assert.equal(pub.status, 404);

  publishDue();

  pub = await api('/api/public/articles/scheduled-test');
  assert.equal(pub.status, 200);
  const detail = await api(`/api/articles/${created.data.id}`, { token: adminToken });
  assert.equal(detail.data.status, 'published');
  assert.equal(detail.data.scheduled_at, null);
});

test('XSS 防护:预览接口转义原始 HTML 与危险链接', async () => {
  const r = await api('/api/articles/preview', {
    method: 'POST',
    token: adminToken,
    body: { content: '<script>alert(1)</script>\n\n[x](javascript:alert(2))\n\n**ok**' },
  });
  assert.equal(r.status, 200);
  assert.ok(!r.data.html.includes('<script>'));
  assert.ok(r.data.html.includes('&lt;script&gt;'));
  assert.ok(!r.data.html.includes('javascript:'));
  assert.ok(r.data.html.includes('<strong>ok</strong>'));
});

test('全文检索:正文关键词能搜到已发布文章', async () => {
  const created = await api('/api/articles', {
    method: 'POST',
    token: adminToken,
    body: { title: '检索目标', slug: 'fts-target', status: 'published', content: '本段包含唯一词:量子加密齿轮。' },
  });
  assert.equal(created.status, 201);

  const found = await api(`/api/public/articles?q=${encodeURIComponent('量子加密齿轮')}`);
  assert.equal(found.data.total, 1);
  assert.equal(found.data.items[0].slug, 'fts-target');
});

test('修订历史:更新自动快照,可恢复', async () => {
  const created = await api('/api/articles', {
    method: 'POST',
    token: adminToken,
    body: { title: '原始标题', slug: 'revision-test', content: '第一版' },
  });
  const id = created.data.id;

  await api(`/api/articles/${id}`, { method: 'PUT', token: adminToken, body: { title: '改过的标题', content: '第二版' } });
  const revisions = await api(`/api/articles/${id}/revisions`, { token: adminToken });
  assert.equal(revisions.data.items.length, 1);
  assert.equal(revisions.data.items[0].title, '原始标题');

  const restored = await api(`/api/articles/${id}/revisions/${revisions.data.items[0].id}/restore`, {
    method: 'POST',
    token: adminToken,
  });
  assert.equal(restored.data.title, '原始标题');
  // 恢复操作本身也快照了一版
  const after2 = await api(`/api/articles/${id}/revisions`, { token: adminToken });
  assert.equal(after2.data.items.length, 2);
});

test('安全响应头:页面带 CSP/nosniff,上传文件沙箱化', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);

  // 1x1 PNG,走真实上传(含缩略图分支)后验证 /uploads 响应头
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'dot.png');
  const uploaded = await fetch(base + '/api/media', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: form,
  });
  assert.equal(uploaded.status, 201);
  const { url } = (await uploaded.json()) as { url: string };
  const file = await fetch(base + url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-security-policy'), 'sandbox');
});

test('站点设置:Bright Data 密钥只返回已配置标记', async () => {
  const saved = await api('/api/settings', {
    method: 'PUT',
    token: adminToken,
    body: {
      brightdata_serp_zone: 'my_serp',
      brightdata_api_key: 'bd-secret',
      browser_executable_path: '/usr/bin/chromium',
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.brightdata_serp_zone, 'my_serp');
  assert.equal(saved.data.browser_executable_path, '/usr/bin/chromium');
  assert.equal(saved.data.brightdata_api_key_set, '1');
  assert.equal(saved.data.brightdata_api_key, undefined);

  const cleared = await api('/api/settings', {
    method: 'PUT',
    token: adminToken,
    body: { brightdata_api_key_clear: '1' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.brightdata_api_key_set, '');
});

test('站点设置:企查查 SecretKey 只返回已配置标记', async () => {
  const saved = await api('/api/settings', {
    method: 'PUT',
    token: adminToken,
    body: { qcc_app_key: 'my-app-key', qcc_secret_key: 'my-secret' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.qcc_app_key, 'my-app-key');
  assert.equal(saved.data.qcc_secret_key_set, '1');
  assert.equal(saved.data.qcc_secret_key, undefined);

  const cleared = await api('/api/settings', { method: 'PUT', token: adminToken, body: { qcc_secret_key_clear: '1' } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.qcc_secret_key_set, '');
});

test('联系表单:前台可提交,后台可查看与管理', async () => {
  const bad = await api('/api/public/contact', { method: 'POST', body: { name: '测试' } });
  assert.equal(bad.status, 400);

  const ok = await api('/api/public/contact', {
    method: 'POST',
    body: { name: '张三', phone: '13800138000', email: 'zhang@example.com', company: '示例公司', message: '想了解产品报价' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.ok, true);

  const list = await api('/api/contacts', { token: adminToken });
  assert.equal(list.status, 200);
  assert.ok(list.data.items.some((c: { name: string }) => c.name === '张三'));

  const id = list.data.items.find((c: { name: string }) => c.name === '张三').id;
  const detail = await api(`/api/contacts/${id}`, { token: adminToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.status, 'read');

  const updated = await api(`/api/contacts/${id}`, { method: 'PUT', token: adminToken, body: { status: 'archived' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.status, 'archived');

  const removed = await api(`/api/contacts/${id}`, { method: 'DELETE', token: adminToken });
  assert.equal(removed.status, 200);
});

test('商品分类:种子数据包含 products 分类', async () => {
  const cats = await api('/api/categories', { token: adminToken });
  assert.ok(cats.data.items.some((c: { slug: string; name: string }) => c.slug === 'products' && c.name === '商品'));
});

test('公开 API 只暴露已发布内容', async () => {
  const draft = await api('/api/articles', {
    method: 'POST',
    token: adminToken,
    body: { title: '秘密草稿', slug: 'secret-draft', status: 'draft' },
  });
  assert.equal(draft.status, 201);
  assert.equal((await api('/api/public/articles/secret-draft')).status, 404);
  const list = await api('/api/public/articles?page_size=50');
  assert.ok(!list.data.items.some((a: { slug: string }) => a.slug === 'secret-draft'));
});
