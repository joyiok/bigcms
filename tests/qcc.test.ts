/**
 * 企查查 API 886 客户端单元测试(mock fetch)
 */
import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bigcms-qcc-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { db } = await import('../src/db.js');
const { qccFuzzySearch, getQccConfig, isQccConfigured } = await import('../src/qcc.js');

before(() => {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('qcc_app_key', 'test-app-key');
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('qcc_secret_key', 'test-secret');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('getQccConfig 从 settings 读取凭证', () => {
  const cfg = getQccConfig();
  assert.equal(cfg.appKey, 'test-app-key');
  assert.equal(cfg.secretKey, 'test-secret');
  assert.equal(isQccConfigured(cfg), true);
});

test('qccFuzzySearch 请求 FuzzySearch/GetList 并校验 Token 头', async () => {
  const original = globalThis.fetch;
  let captured: { url: string; headers: Headers } | undefined;
  globalThis.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    captured = { url: String(url), headers: new Headers(init?.headers) };
    return new Response(
      JSON.stringify({
        Status: '200',
        Message: '成功',
        Result: [{ Name: '示例科技有限公司', CreditCode: '91110000MA00000000', Status: '存续' }],
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    const data = await qccFuzzySearch({ searchKey: '示例科技', pageIndex: 1 });
    assert.match(captured?.url ?? '', /api\.qichacha\.com\/FuzzySearch\/GetList/);
    assert.match(captured?.url ?? '', /searchKey=%E7%A4%BA%E4%BE%8B%E7%A7%91%E6%8A%80/);
    const token = captured?.headers.get('Token') ?? '';
    const timespan = captured?.headers.get('Timespan') ?? '';
    const expected = crypto
      .createHash('md5')
      .update(`test-app-key${timespan}test-secret`)
      .digest('hex')
      .toUpperCase();
    assert.equal(token, expected);
    assert.equal(data.companies[0].Name, '示例科技有限公司');
  } finally {
    globalThis.fetch = original;
  }
});

test('qccFuzzySearch 未配置时抛出明确错误', async () => {
  db.prepare(`DELETE FROM settings WHERE key IN ('qcc_app_key', 'qcc_secret_key')`).run();
  await assert.rejects(() => qccFuzzySearch({ searchKey: '测试' }), /企查查 API 未配置/);
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('qcc_app_key', 'test-app-key');
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('qcc_secret_key', 'test-secret');
});

test('qccFuzzySearch API 业务错误时抛出 Message', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mock.fn(async () =>
    new Response(JSON.stringify({ Status: '101', Message: 'AppKey无效' }), { status: 200 })
  ) as typeof fetch;
  try {
    await assert.rejects(() => qccFuzzySearch({ searchKey: '测试' }), /AppKey无效/);
  } finally {
    globalThis.fetch = original;
  }
});
