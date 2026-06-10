import { Router } from 'express';
import { articleSearchCondition, db, snapshotArticle, toUtcDateTime } from '../db.js';
import { renderMarkdown } from '../markdown.js';
import { audit, requireAuth, requireRole } from '../auth.js';
import { slugify } from '../slug.js';

export const articlesRouter = Router();

articlesRouter.use(requireAuth);

const LIST_SQL = `
  SELECT a.id, a.title, a.slug, a.summary, a.status, a.views, a.cover_image,
         a.category_id, c.name AS category_name,
         a.author_id, u.display_name AS author_name,
         a.published_at, a.scheduled_at, a.created_at, a.updated_at
  FROM articles a
  LEFT JOIN categories c ON c.id = a.category_id
  LEFT JOIN users u ON u.id = a.author_id`;

function attachTags(article: { id: number } & Record<string, unknown>) {
  const tags = db
    .prepare(`SELECT t.id, t.name, t.slug FROM tags t JOIN article_tags at ON at.tag_id = t.id WHERE at.article_id = ?`)
    .all(article.id);
  return { ...article, tags };
}

function setTags(articleId: number, tagIds: unknown): void {
  if (!Array.isArray(tagIds)) return;
  db.prepare(`DELETE FROM article_tags WHERE article_id = ?`).run(articleId);
  const insert = db.prepare(`INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)`);
  for (const tagId of tagIds) insert.run(articleId, Number(tagId));
}

articlesRouter.get('/', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 10));
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (req.query.status) {
    conditions.push('a.status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.category_id) {
    conditions.push('a.category_id = ?');
    params.push(Number(req.query.category_id));
  }
  if (req.query.q) {
    const search = articleSearchCondition(String(req.query.q));
    conditions.push(search.sql);
    params.push(...search.params);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

  const total = (db.prepare(`SELECT COUNT(*) AS c FROM articles a${where}`).get(...params) as { c: number }).c;
  const items = (
    db
      .prepare(`${LIST_SQL}${where} ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as ({ id: number } & Record<string, unknown>)[]
  ).map(attachTags);

  res.json({ items, total, page, page_size: pageSize });
});

// Markdown 预览(与前台 site.ts 同一渲染器,所见即所得)
articlesRouter.post('/preview', requireRole('editor'), (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  res.json({ html: renderMarkdown(content) });
});

articlesRouter.get('/:id', (req, res) => {
  const article = db
    .prepare(`${LIST_SQL} WHERE a.id = ?`)
    .get(Number(req.params.id)) as ({ id: number } & Record<string, unknown>) | undefined;
  if (!article) {
    res.status(404).json({ error: '文章不存在' });
    return;
  }
  const content = db.prepare(`SELECT content FROM articles WHERE id = ?`).get(article.id) as { content: string };
  res.json({ ...attachTags(article), content: content.content });
});

articlesRouter.post('/', requireRole('editor'), (req, res) => {
  const { title, slug, summary = '', content = '', cover_image = '', status = 'draft', category_id = null, tag_ids, scheduled_at } =
    req.body ?? {};
  if (!title) {
    res.status(400).json({ error: '标题必填' });
    return;
  }
  if (!['draft', 'published', 'archived'].includes(status)) {
    res.status(400).json({ error: '状态无效' });
    return;
  }
  let scheduledAt: string | null;
  try {
    // 定时发布只对草稿生效
    scheduledAt = status === 'draft' ? toUtcDateTime(scheduled_at) : null;
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const finalSlug = slug ? slugify(String(slug)) : slugify(String(title));
  try {
    const id = db
      .prepare(
        `INSERT INTO articles (title, slug, summary, content, cover_image, status, category_id, author_id, published_at, scheduled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'published' THEN datetime('now') ELSE NULL END, ?)`
      )
      .run(title, finalSlug, summary, content, cover_image, status, category_id, req.user!.id, status, scheduledAt)
      .lastInsertRowid as number;
    setTags(id, tag_ids);
    audit(req, 'create_article', `article:${id}`, String(title));
    res.status(201).json(attachTags(db.prepare(`${LIST_SQL} WHERE a.id = ?`).get(id) as { id: number }));
  } catch {
    res.status(409).json({ error: 'slug 已存在,请换一个' });
  }
});

articlesRouter.put('/:id', requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT id, status FROM articles WHERE id = ?`).get(id) as
    | { id: number; status: string }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '文章不存在' });
    return;
  }
  const { title, slug, summary, content, cover_image, status, category_id, tag_ids, scheduled_at } = req.body ?? {};
  if (status && !['draft', 'published', 'archived'].includes(status)) {
    res.status(400).json({ error: '状态无效' });
    return;
  }
  const finalStatus = status ?? existing.status;
  // 三态:undefined 保持不变,null 取消定时,字符串设定时;非草稿一律清掉
  const setScheduled = scheduled_at !== undefined || finalStatus !== 'draft';
  let scheduledAt: string | null = null;
  if (scheduled_at !== undefined && finalStatus === 'draft') {
    try {
      scheduledAt = toUtcDateTime(scheduled_at);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }
  snapshotArticle(id, req.user!.username);
  try {
    db.prepare(
      `UPDATE articles SET
         title = COALESCE(?, title),
         slug = COALESCE(?, slug),
         summary = COALESCE(?, summary),
         content = COALESCE(?, content),
         cover_image = COALESCE(?, cover_image),
         status = COALESCE(?, status),
         category_id = ?,
         scheduled_at = CASE WHEN ? THEN ? ELSE scheduled_at END,
         published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN datetime('now') ELSE published_at END,
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      title ?? null,
      slug ? slugify(String(slug)) : null,
      summary ?? null,
      content ?? null,
      cover_image ?? null,
      status ?? null,
      category_id === undefined ? (db.prepare(`SELECT category_id FROM articles WHERE id = ?`).get(id) as { category_id: number | null }).category_id : category_id,
      setScheduled ? 1 : 0,
      scheduledAt,
      finalStatus,
      id
    );
    setTags(id, tag_ids);
    audit(req, 'update_article', `article:${id}`);
    res.json(attachTags(db.prepare(`${LIST_SQL} WHERE a.id = ?`).get(id) as { id: number }));
  } catch {
    res.status(409).json({ error: 'slug 已存在,请换一个' });
  }
});

// ---- 修订历史 ----
articlesRouter.get('/:id/revisions', (req, res) => {
  const articleId = Number(req.params.id);
  if (!db.prepare(`SELECT id FROM articles WHERE id = ?`).get(articleId)) {
    res.status(404).json({ error: '文章不存在' });
    return;
  }
  const items = db
    .prepare(
      `SELECT id, title, status, saved_by, created_at, length(content) AS content_length
       FROM article_revisions WHERE article_id = ? ORDER BY id DESC`
    )
    .all(articleId);
  res.json({ items });
});

articlesRouter.get('/:id/revisions/:revId', (req, res) => {
  const revision = db
    .prepare(`SELECT * FROM article_revisions WHERE id = ? AND article_id = ?`)
    .get(Number(req.params.revId), Number(req.params.id));
  if (!revision) {
    res.status(404).json({ error: '修订版本不存在' });
    return;
  }
  res.json(revision);
});

articlesRouter.post('/:id/revisions/:revId/restore', requireRole('editor'), (req, res) => {
  const articleId = Number(req.params.id);
  const revision = db
    .prepare(`SELECT * FROM article_revisions WHERE id = ? AND article_id = ?`)
    .get(Number(req.params.revId), Number(req.params.id)) as
    | { id: number; title: string; slug: string; summary: string; content: string; cover_image: string }
    | undefined;
  if (!revision) {
    res.status(404).json({ error: '修订版本不存在' });
    return;
  }
  // 恢复前先快照当前版,保证操作本身也可回退;只还原内容字段,不动状态/分类/发布时间
  snapshotArticle(articleId, req.user!.username);
  const restore = (withSlug: boolean) =>
    db
      .prepare(
        `UPDATE articles SET title = ?, ${withSlug ? 'slug = ?,' : ''} summary = ?, content = ?, cover_image = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(
        ...(withSlug
          ? [revision.title, revision.slug, revision.summary, revision.content, revision.cover_image, articleId]
          : [revision.title, revision.summary, revision.content, revision.cover_image, articleId])
      );
  try {
    restore(true);
  } catch {
    // 旧 slug 已被其他文章占用:保留现有 slug,仅恢复其余字段
    restore(false);
  }
  audit(req, 'restore_article_revision', `article:${articleId}`, `revision:${revision.id}`);
  res.json(attachTags(db.prepare(`${LIST_SQL} WHERE a.id = ?`).get(articleId) as { id: number }));
});

articlesRouter.delete('/:id', requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare(`DELETE FROM articles WHERE id = ?`).run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: '文章不存在' });
    return;
  }
  audit(req, 'delete_article', `article:${id}`);
  res.json({ ok: true });
});
