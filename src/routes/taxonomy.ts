import { Router } from 'express';
import { db } from '../db.js';
import { audit, requireAuth, requireRole } from '../auth.js';
import { slugify } from '../slug.js';

export const categoriesRouter = Router();
export const tagsRouter = Router();

categoriesRouter.use(requireAuth);
tagsRouter.use(requireAuth);

categoriesRouter.get('/', (_req, res) => {
  const items = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id) AS article_count
       FROM categories c ORDER BY c.sort_order, c.id`
    )
    .all();
  res.json({ items });
});

categoriesRouter.post('/', requireRole('editor'), (req, res) => {
  const { name, slug, description = '', parent_id = null, sort_order = 0 } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: '名称必填' });
    return;
  }
  try {
    const id = db
      .prepare(`INSERT INTO categories (name, slug, description, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)`)
      .run(name, slug ? slugify(String(slug)) : slugify(String(name)), description, parent_id, sort_order).lastInsertRowid;
    audit(req, 'create_category', `category:${id}`, String(name));
    res.status(201).json(db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id));
  } catch {
    res.status(409).json({ error: 'slug 已存在' });
  }
});

categoriesRouter.put('/:id', requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const { name, slug, description, parent_id, sort_order } = req.body ?? {};
  if (parent_id === id) {
    res.status(400).json({ error: '父分类不能是自己' });
    return;
  }
  try {
    const result = db
      .prepare(
        `UPDATE categories SET
           name = COALESCE(?, name),
           slug = COALESCE(?, slug),
           description = COALESCE(?, description),
           parent_id = ?,
           sort_order = COALESCE(?, sort_order)
         WHERE id = ?`
      )
      .run(
        name ?? null,
        slug ? slugify(String(slug)) : null,
        description ?? null,
        parent_id === undefined
          ? ((db.prepare(`SELECT parent_id FROM categories WHERE id = ?`).get(id) as { parent_id: number | null } | undefined)?.parent_id ?? null)
          : parent_id,
        sort_order ?? null,
        id
      );
    if (result.changes === 0) {
      res.status(404).json({ error: '分类不存在' });
      return;
    }
    audit(req, 'update_category', `category:${id}`);
    res.json(db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id));
  } catch {
    res.status(409).json({ error: 'slug 已存在' });
  }
});

categoriesRouter.delete('/:id', requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const inUse = db.prepare(`SELECT COUNT(*) AS c FROM articles WHERE category_id = ?`).get(id) as { c: number };
  if (inUse.c > 0) {
    res.status(400).json({ error: `该分类下还有 ${inUse.c} 篇文章,无法删除` });
    return;
  }
  const result = db.prepare(`DELETE FROM categories WHERE id = ?`).run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: '分类不存在' });
    return;
  }
  audit(req, 'delete_category', `category:${id}`);
  res.json({ ok: true });
});

tagsRouter.get('/', (_req, res) => {
  const items = db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM article_tags at WHERE at.tag_id = t.id) AS article_count
       FROM tags t ORDER BY t.id`
    )
    .all();
  res.json({ items });
});

tagsRouter.post('/', requireRole('editor'), (req, res) => {
  const { name, slug } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: '名称必填' });
    return;
  }
  try {
    const id = db
      .prepare(`INSERT INTO tags (name, slug) VALUES (?, ?)`)
      .run(name, slug ? slugify(String(slug)) : slugify(String(name))).lastInsertRowid;
    audit(req, 'create_tag', `tag:${id}`, String(name));
    res.status(201).json(db.prepare(`SELECT * FROM tags WHERE id = ?`).get(id));
  } catch {
    res.status(409).json({ error: '标签名或 slug 已存在' });
  }
});

tagsRouter.delete('/:id', requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: '标签不存在' });
    return;
  }
  audit(req, 'delete_tag', `tag:${id}`);
  res.json({ ok: true });
});
