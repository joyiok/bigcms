import { Router } from 'express';
import { articleSearchCondition, db } from '../db.js';
import { audit, requireAuth, requireRole } from '../auth.js';
import { getSafeSettings } from '../settings.js';
import { resetAssistantSessions } from '../assistant/manager.js';

export const settingsRouter = Router();
export const dashboardRouter = Router();
export const auditRouter = Router();
export const publicRouter = Router();

/** 联系表单提交限速:同一 IP 15 分钟内最多 5 次 */
const CONTACT_WINDOW_MS = 15 * 60 * 1000;
const CONTACT_MAX_SUBMISSIONS = 5;
const contactSubmissions = new Map<string, number[]>();

function pruneContactSubmissions(ip: string): number[] {
  const now = Date.now();
  const list = (contactSubmissions.get(ip) ?? []).filter((t) => now - t < CONTACT_WINDOW_MS);
  if (list.length) contactSubmissions.set(ip, list);
  else contactSubmissions.delete(ip);
  return list;
}

// ---- 站点设置 ----
settingsRouter.get('/', requireAuth, (req, res) => {
  res.json(getSafeSettings(req.user?.role === 'admin'));
});

const AI_PROVIDERS = new Set(['', 'deepseek', 'openai', 'anthropic']);
const AI_THINKING_LEVELS = new Set(['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

settingsRouter.put('/', requireAuth, requireRole('admin'), async (req, res) => {
  const body = req.body ?? {};
  const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const del = db.prepare(`DELETE FROM settings WHERE key = ?`);
  const changed: string[] = [];
  let aiChanged = false;

  if (body.ai_provider !== undefined && !AI_PROVIDERS.has(String(body.ai_provider))) {
    res.status(400).json({ error: 'AI 提供商无效' });
    return;
  }
  if (body.ai_thinking !== undefined && !AI_THINKING_LEVELS.has(String(body.ai_thinking))) {
    res.status(400).json({ error: 'AI 思考强度无效' });
    return;
  }
  if (typeof body.ai_api_key === 'string' && body.ai_api_key.trim() && !String(body.ai_provider ?? '').trim()) {
    res.status(400).json({ error: '填写 API Key 时请选择 AI 提供商' });
    return;
  }

  for (const [key, value] of Object.entries(body)) {
    if (!/^[a-z0-9_]+$/i.test(key) || typeof value !== 'string') continue;
    if (key === 'ai_api_key_set' || key === 'brightdata_api_key_set' || key === 'brightdata_browser_password_set') continue;
    if (key === 'ai_api_key_clear') {
      if (value === '1') {
        del.run('ai_api_key');
        changed.push('ai_api_key');
        aiChanged = true;
      }
      continue;
    }
    if (key === 'brightdata_api_key_clear') {
      if (value === '1') {
        del.run('brightdata_api_key');
        changed.push('brightdata_api_key');
      }
      continue;
    }
    if (key === 'brightdata_browser_password_clear') {
      if (value === '1') {
        del.run('brightdata_browser_password');
        changed.push('brightdata_browser_password');
      }
      continue;
    }
    if ((key === 'ai_api_key' || key === 'brightdata_api_key' || key === 'brightdata_browser_password') && value.trim() === '') continue;
    upsert.run(key, value.trim());
    changed.push(key);
    if (key.startsWith('ai_')) aiChanged = true;
  }

  if (aiChanged) await resetAssistantSessions();
  audit(req, 'update_settings', '', changed.join(','));
  res.json(getSafeSettings(true));
});

// ---- 仪表盘统计 ----
dashboardRouter.get('/stats', requireAuth, (_req, res) => {
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  res.json({
    articles_total: count(`SELECT COUNT(*) AS c FROM articles`),
    articles_published: count(`SELECT COUNT(*) AS c FROM articles WHERE status = 'published'`),
    articles_draft: count(`SELECT COUNT(*) AS c FROM articles WHERE status = 'draft'`),
    categories: count(`SELECT COUNT(*) AS c FROM categories`),
    tags: count(`SELECT COUNT(*) AS c FROM tags`),
    media: count(`SELECT COUNT(*) AS c FROM media`),
    users: count(`SELECT COUNT(*) AS c FROM users`),
    contacts: count(`SELECT COUNT(*) AS c FROM contacts`),
    contacts_new: count(`SELECT COUNT(*) AS c FROM contacts WHERE status = 'new'`),
    total_views: (db.prepare(`SELECT COALESCE(SUM(views), 0) AS c FROM articles`).get() as { c: number }).c,
    recent_articles: db
      .prepare(`SELECT id, title, status, updated_at FROM articles ORDER BY updated_at DESC LIMIT 5`)
      .all(),
    recent_logs: db
      .prepare(`SELECT username, action, target, created_at FROM audit_logs ORDER BY id DESC LIMIT 8`)
      .all(),
  });
});

// ---- 审计日志 ----
auditRouter.get('/', requireAuth, requireRole('admin'), (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 50));
  const conditions: string[] = [];
  const params: string[] = [];
  if (req.query.action) {
    conditions.push('action = ?');
    params.push(String(req.query.action));
  }
  if (req.query.username) {
    conditions.push('username = ?');
    params.push(String(req.query.username));
  }
  if (req.query.q) {
    conditions.push('(target LIKE ? OR detail LIKE ?)');
    const kw = `%${req.query.q}%`;
    params.push(kw, kw);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM audit_logs${where}`).get(...params) as { c: number }).c;
  const items = db
    .prepare(`SELECT * FROM audit_logs${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  const actions = (db.prepare(`SELECT DISTINCT action FROM audit_logs ORDER BY action`).all() as { action: string }[]).map((r) => r.action);
  const usernames = (db.prepare(`SELECT DISTINCT username FROM audit_logs WHERE username != '' ORDER BY username`).all() as { username: string }[]).map((r) => r.username);
  res.json({ items, total, page, page_size: pageSize, actions, usernames });
});

// ---- 公开内容 API(无需登录,供前台站点调用) ----
publicRouter.get('/articles', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(req.query.page_size) || 10));
  const conditions = [`a.status = 'published'`];
  const params: (string | number)[] = [];
  if (req.query.category) {
    conditions.push('c.slug = ?');
    params.push(String(req.query.category));
  }
  if (req.query.tag) {
    conditions.push('EXISTS (SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id AND t.slug = ?)');
    params.push(String(req.query.tag));
  }
  if (req.query.q) {
    const search = articleSearchCondition(String(req.query.q).slice(0, 100));
    conditions.push(search.sql);
    params.push(...search.params);
  }
  const where = ` WHERE ${conditions.join(' AND ')}`;
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM articles a LEFT JOIN categories c ON c.id = a.category_id${where}`).get(...params) as { c: number }
  ).c;
  const items = db
    .prepare(
      `SELECT a.id, a.title, a.slug, a.summary, a.cover_image, a.views, a.published_at,
              c.name AS category_name, c.slug AS category_slug, u.display_name AS author_name
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN users u ON u.id = a.author_id
       ${where} ORDER BY a.published_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({ items, total, page, page_size: pageSize });
});

publicRouter.get('/articles/:slug', (req, res) => {
  const article = db
    .prepare(
      `SELECT a.id, a.title, a.slug, a.summary, a.content, a.cover_image, a.views, a.published_at,
              c.name AS category_name, u.display_name AS author_name
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN users u ON u.id = a.author_id
       WHERE a.slug = ? AND a.status = 'published'`
    )
    .get(req.params.slug) as { id: number } | undefined;
  if (!article) {
    res.status(404).json({ error: '文章不存在' });
    return;
  }
  db.prepare(`UPDATE articles SET views = views + 1 WHERE id = ?`).run(article.id);
  const tags = db
    .prepare(`SELECT t.name, t.slug FROM tags t JOIN article_tags at ON at.tag_id = t.id WHERE at.article_id = ?`)
    .all(article.id);
  res.json({ ...article, tags });
});

publicRouter.get('/site', (_req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

publicRouter.post('/contact', (req, res) => {
  const ip = String(req.ip ?? '');
  if (pruneContactSubmissions(ip).length >= CONTACT_MAX_SUBMISSIONS) {
    res.status(429).json({ error: '提交过于频繁,请稍后再试' });
    return;
  }

  const body = req.body ?? {};
  if (body.website) {
    res.status(201).json({ ok: true });
    return;
  }

  const name = String(body.name ?? '').trim().slice(0, 80);
  const phone = String(body.phone ?? '').trim().slice(0, 40);
  const email = String(body.email ?? '').trim().slice(0, 120);
  const company = String(body.company ?? '').trim().slice(0, 120);
  const message = String(body.message ?? '').trim().slice(0, 2000);

  if (!name) {
    res.status(400).json({ error: '请填写姓名' });
    return;
  }
  if (!phone) {
    res.status(400).json({ error: '请填写电话' });
    return;
  }
  if (!message) {
    res.status(400).json({ error: '请填写留言' });
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: '邮箱格式无效' });
    return;
  }

  db.prepare(`INSERT INTO contacts (name, email, phone, company, message, ip) VALUES (?, ?, ?, ?, ?, ?)`).run(
    name,
    email,
    phone,
    company,
    message,
    ip
  );
  contactSubmissions.set(ip, [...pruneContactSubmissions(ip), Date.now()]);
  res.status(201).json({ ok: true });
});
