/** AI 助手可调用的 CMS 管理工具(基于 Pi SDK 的自定义工具) */
import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { config } from '../config.js';
import { articleSearchCondition, db, snapshotArticle, toUtcDateTime } from '../db.js';
import { slugify } from '../slug.js';
import { hashPassword } from '../password.js';
import type { AuthUser } from '../auth.js';
import { getSafeSettings } from '../settings.js';

/** 工具返回:把数据序列化为 JSON 文本交给模型 */
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], details: {} };
}

/** AI 助手操作写入审计日志(action 以 ai: 前缀标识) */
function auditAi(user: AuthUser, action: string, target = '', detail = ''): void {
  db.prepare(`INSERT INTO audit_logs (user_id, username, action, target, detail) VALUES (?, ?, ?, ?, ?)`).run(
    user.id,
    user.username,
    `ai:${action}`,
    target,
    detail
  );
}

const ARTICLE_LIST_SQL = `
  SELECT a.id, a.title, a.slug, a.summary, a.status, a.views, a.cover_image,
         a.category_id, c.name AS category_name,
         a.author_id, u.display_name AS author_name,
         a.published_at, a.scheduled_at, a.created_at, a.updated_at
  FROM articles a
  LEFT JOIN categories c ON c.id = a.category_id
  LEFT JOIN users u ON u.id = a.author_id`;

function articleWithTags(article: { id: number } & Record<string, unknown>) {
  const tags = db
    .prepare(`SELECT t.id, t.name, t.slug FROM tags t JOIN article_tags at ON at.tag_id = t.id WHERE at.article_id = ?`)
    .all(article.id);
  return { ...article, tags };
}

/** 按标签名设置文章标签;不存在的标签自动创建 */
function setTagsByNames(articleId: number, tagNames: string[] | undefined): void {
  if (!Array.isArray(tagNames)) return;
  db.prepare(`DELETE FROM article_tags WHERE article_id = ?`).run(articleId);
  const link = db.prepare(`INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)`);
  for (const raw of tagNames) {
    const name = String(raw).trim();
    if (!name) continue;
    let tag = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(name) as { id: number } | undefined;
    if (!tag) {
      const id = db.prepare(`INSERT INTO tags (name, slug) VALUES (?, ?)`).run(name, slugify(name))
        .lastInsertRowid as number;
      tag = { id };
    }
    link.run(articleId, tag.id);
  }
}

const STATUS_VALUES = ['draft', 'published', 'archived'];

export function buildAssistantTools(user: AuthUser): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // ---- 概览 ----
  tools.push(
    defineTool({
      name: 'get_stats',
      label: '站点统计',
      description: '获取站点内容统计:文章数、分类、标签、媒体、用户、总浏览量、最近更新等。',
      parameters: Type.Object({}),
      execute: async () => {
        const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
        return ok({
          articles_total: count(`SELECT COUNT(*) AS c FROM articles`),
          articles_published: count(`SELECT COUNT(*) AS c FROM articles WHERE status = 'published'`),
          articles_draft: count(`SELECT COUNT(*) AS c FROM articles WHERE status = 'draft'`),
          articles_archived: count(`SELECT COUNT(*) AS c FROM articles WHERE status = 'archived'`),
          categories: count(`SELECT COUNT(*) AS c FROM categories`),
          tags: count(`SELECT COUNT(*) AS c FROM tags`),
          media: count(`SELECT COUNT(*) AS c FROM media`),
          users: count(`SELECT COUNT(*) AS c FROM users`),
          total_views: (db.prepare(`SELECT COALESCE(SUM(views), 0) AS c FROM articles`).get() as { c: number }).c,
          recent_articles: db
            .prepare(`SELECT id, title, status, updated_at FROM articles ORDER BY updated_at DESC LIMIT 5`)
            .all(),
        });
      },
    })
  );

  // ---- 文章 ----
  tools.push(
    defineTool({
      name: 'list_articles',
      label: '文章列表',
      description: '分页查询文章列表,支持按状态(draft/published/archived)、分类 ID、标签名、关键词筛选。',
      parameters: Type.Object({
        page: Type.Optional(Type.Number({ description: '页码,默认 1' })),
        page_size: Type.Optional(Type.Number({ description: '每页条数,默认 10,最大 100' })),
        status: Type.Optional(Type.String({ description: '状态:draft / published / archived' })),
        category_id: Type.Optional(Type.Number({ description: '分类 ID' })),
        tag: Type.Optional(Type.String({ description: '标签名或标签 slug' })),
        q: Type.Optional(Type.String({ description: '关键词(标题/摘要/正文全文检索)' })),
      }),
      execute: async (_id, p) => {
        const page = Math.max(1, p.page ?? 1);
        const pageSize = Math.min(100, Math.max(1, p.page_size ?? 10));
        const conditions: string[] = [];
        const params: (string | number)[] = [];
        if (p.status) {
          conditions.push('a.status = ?');
          params.push(p.status);
        }
        if (p.category_id) {
          conditions.push('a.category_id = ?');
          params.push(p.category_id);
        }
        if (p.tag) {
          conditions.push(
            'EXISTS (SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id AND (t.name = ? OR t.slug = ?))'
          );
          params.push(p.tag, p.tag);
        }
        if (p.q) {
          const search = articleSearchCondition(p.q);
          conditions.push(search.sql);
          params.push(...search.params);
        }
        const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
        const total = (db.prepare(`SELECT COUNT(*) AS c FROM articles a${where}`).get(...params) as { c: number }).c;
        const items = (
          db
            .prepare(`${ARTICLE_LIST_SQL}${where} ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`)
            .all(...params, pageSize, (page - 1) * pageSize) as ({ id: number } & Record<string, unknown>)[]
        ).map(articleWithTags);
        return ok({ items, total, page, page_size: pageSize });
      },
    }),
    defineTool({
      name: 'get_article',
      label: '文章详情',
      description: '按 ID 或 slug 获取单篇文章的完整信息(含 Markdown 正文和标签)。',
      parameters: Type.Object({
        id: Type.Optional(Type.Number({ description: '文章 ID' })),
        slug: Type.Optional(Type.String({ description: '文章 slug(与 id 二选一)' })),
      }),
      execute: async (_id, p) => {
        const row = p.id
          ? db.prepare(`${ARTICLE_LIST_SQL} WHERE a.id = ?`).get(p.id)
          : p.slug
            ? db.prepare(`${ARTICLE_LIST_SQL} WHERE a.slug = ?`).get(p.slug)
            : undefined;
        if (!row) throw new Error('文章不存在(请提供有效的 id 或 slug)');
        const article = row as { id: number } & Record<string, unknown>;
        const { content } = db.prepare(`SELECT content FROM articles WHERE id = ?`).get(article.id) as {
          content: string;
        };
        return ok({ ...articleWithTags(article), content });
      },
    }),
    defineTool({
      name: 'create_article',
      label: '新建文章',
      description:
        '创建一篇文章。正文为 Markdown。status 可为 draft(草稿)/published(发布)/archived(归档),默认 draft。tags 传标签名数组,不存在的标签会自动创建。',
      parameters: Type.Object({
        title: Type.String({ description: '标题(必填)' }),
        slug: Type.Optional(Type.String({ description: 'URL slug,留空自动从标题生成' })),
        summary: Type.Optional(Type.String({ description: '摘要' })),
        content: Type.Optional(Type.String({ description: 'Markdown 正文' })),
        cover_image: Type.Optional(Type.String({ description: '封面图 URL' })),
        status: Type.Optional(Type.String({ description: 'draft / published / archived,默认 draft' })),
        category_id: Type.Optional(Type.Number({ description: '分类 ID' })),
        tags: Type.Optional(Type.Array(Type.String(), { description: '标签名数组' })),
        scheduled_at: Type.Optional(
          Type.String({ description: '定时发布时间,ISO 8601(如 2026-06-12T09:00:00+08:00);仅草稿生效,到点自动发布' })
        ),
      }),
      execute: async (_id, p) => {
        const status = p.status ?? 'draft';
        if (!STATUS_VALUES.includes(status)) throw new Error('状态无效,必须是 draft / published / archived');
        if (p.category_id) {
          const cat = db.prepare(`SELECT id FROM categories WHERE id = ?`).get(p.category_id);
          if (!cat) throw new Error(`分类 ${p.category_id} 不存在,可先用 list_categories 查看`);
        }
        const scheduledAt = status === 'draft' ? toUtcDateTime(p.scheduled_at) : null;
        const finalSlug = p.slug ? slugify(p.slug) : slugify(p.title);
        let id: number;
        try {
          id = db
            .prepare(
              `INSERT INTO articles (title, slug, summary, content, cover_image, status, category_id, author_id, published_at, scheduled_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'published' THEN datetime('now') ELSE NULL END, ?)`
            )
            .run(
              p.title,
              finalSlug,
              p.summary ?? '',
              p.content ?? '',
              p.cover_image ?? '',
              status,
              p.category_id ?? null,
              user.id,
              status,
              scheduledAt
            ).lastInsertRowid as number;
        } catch {
          throw new Error(`slug "${finalSlug}" 已存在,请换一个`);
        }
        setTagsByNames(id, p.tags);
        auditAi(user, 'create_article', `article:${id}`, p.title);
        return ok(articleWithTags(db.prepare(`${ARTICLE_LIST_SQL} WHERE a.id = ?`).get(id) as { id: number }));
      },
    }),
    defineTool({
      name: 'update_article',
      label: '更新文章',
      description:
        '更新文章,只传需要修改的字段。将 status 设为 published 即发布,draft 即转回草稿。tags 传标签名数组会整体替换现有标签。',
      parameters: Type.Object({
        id: Type.Number({ description: '文章 ID(必填)' }),
        title: Type.Optional(Type.String()),
        slug: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        content: Type.Optional(Type.String({ description: 'Markdown 正文(整体替换)' })),
        cover_image: Type.Optional(Type.String()),
        status: Type.Optional(Type.String({ description: 'draft / published / archived' })),
        category_id: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: '分类 ID,null 表示移除分类' })),
        tags: Type.Optional(Type.Array(Type.String(), { description: '标签名数组(整体替换)' })),
        scheduled_at: Type.Optional(
          Type.Union([Type.String(), Type.Null()], { description: '定时发布时间,ISO 8601;仅草稿生效,null 取消定时' })
        ),
      }),
      execute: async (_id, p) => {
        const existing = db.prepare(`SELECT id, status, category_id FROM articles WHERE id = ?`).get(p.id) as
          | { id: number; status: string; category_id: number | null }
          | undefined;
        if (!existing) throw new Error('文章不存在');
        if (p.status && !STATUS_VALUES.includes(p.status)) throw new Error('状态无效');
        const finalStatus = p.status ?? existing.status;
        const setScheduled = p.scheduled_at !== undefined || finalStatus !== 'draft';
        const scheduledAt = p.scheduled_at !== undefined && finalStatus === 'draft' ? toUtcDateTime(p.scheduled_at) : null;
        snapshotArticle(p.id, `${user.username}(AI)`);
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
            p.title ?? null,
            p.slug ? slugify(p.slug) : null,
            p.summary ?? null,
            p.content ?? null,
            p.cover_image ?? null,
            p.status ?? null,
            p.category_id === undefined ? existing.category_id : p.category_id,
            setScheduled ? 1 : 0,
            scheduledAt,
            finalStatus,
            p.id
          );
        } catch {
          throw new Error('slug 已存在,请换一个');
        }
        setTagsByNames(p.id, p.tags);
        auditAi(user, 'update_article', `article:${p.id}`);
        return ok(articleWithTags(db.prepare(`${ARTICLE_LIST_SQL} WHERE a.id = ?`).get(p.id) as { id: number }));
      },
    }),
    defineTool({
      name: 'delete_article',
      label: '删除文章',
      description: '永久删除一篇文章(不可恢复)。删除前必须得到用户的明确确认。',
      parameters: Type.Object({
        id: Type.Number({ description: '文章 ID' }),
      }),
      execute: async (_id, p) => {
        const existing = db.prepare(`SELECT title FROM articles WHERE id = ?`).get(p.id) as
          | { title: string }
          | undefined;
        if (!existing) throw new Error('文章不存在');
        db.prepare(`DELETE FROM articles WHERE id = ?`).run(p.id);
        auditAi(user, 'delete_article', `article:${p.id}`, existing.title);
        return ok({ ok: true, deleted: existing.title });
      },
    }),
    defineTool({
      name: 'bulk_update_articles',
      label: '批量更新文章',
      description:
        '按 ID 列表批量修改文章的状态和/或分类(如批量发布草稿、批量归档、批量移动分类)。一次最多 50 篇。执行前必须先向用户列出将受影响的文章并得到明确确认。',
      parameters: Type.Object({
        ids: Type.Array(Type.Number(), { description: '文章 ID 数组(必填,最多 50 个)' }),
        status: Type.Optional(Type.String({ description: '统一改为该状态:draft / published / archived' })),
        category_id: Type.Optional(
          Type.Union([Type.Number(), Type.Null()], { description: '统一移动到该分类,null 表示移除分类' })
        ),
      }),
      execute: async (_id, p) => {
        if (!p.ids.length) throw new Error('ids 不能为空');
        if (p.ids.length > 50) throw new Error('一次最多批量处理 50 篇');
        if (p.status === undefined && p.category_id === undefined) throw new Error('至少指定 status 或 category_id 之一');
        if (p.status && !STATUS_VALUES.includes(p.status)) throw new Error('状态无效,必须是 draft / published / archived');
        if (typeof p.category_id === 'number') {
          const cat = db.prepare(`SELECT id FROM categories WHERE id = ?`).get(p.category_id);
          if (!cat) throw new Error(`分类 ${p.category_id} 不存在,可先用 list_categories 查看`);
        }
        const update = db.prepare(
          `UPDATE articles SET
             status = COALESCE(?, status),
             category_id = CASE WHEN ? THEN ? ELSE category_id END,
             published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN datetime('now') ELSE published_at END,
             updated_at = datetime('now')
           WHERE id = ?`
        );
        const updated: number[] = [];
        const missing: number[] = [];
        for (const rawId of p.ids) {
          const id = Number(rawId);
          snapshotArticle(id, `${user.username}(AI)`);
          const result = update.run(
            p.status ?? null,
            p.category_id === undefined ? 0 : 1,
            p.category_id === undefined ? null : p.category_id,
            p.status ?? '',
            id
          );
          (result.changes > 0 ? updated : missing).push(id);
        }
        auditAi(
          user,
          'bulk_update_articles',
          `articles:${updated.join(',')}`,
          [p.status && `status→${p.status}`, p.category_id !== undefined && `category→${p.category_id}`].filter(Boolean).join(' ')
        );
        return ok({ updated, missing, count: updated.length });
      },
    })
  );

  // ---- 修订历史 ----
  tools.push(
    defineTool({
      name: 'list_article_revisions',
      label: '修订历史',
      description: '查看一篇文章的修订历史(每次更新前自动快照,最多保留 20 版)。',
      parameters: Type.Object({
        article_id: Type.Number({ description: '文章 ID' }),
      }),
      execute: async (_id, p) => {
        if (!db.prepare(`SELECT id FROM articles WHERE id = ?`).get(p.article_id)) throw new Error('文章不存在');
        return ok(
          db
            .prepare(
              `SELECT id, title, status, saved_by, created_at, length(content) AS content_length
               FROM article_revisions WHERE article_id = ? ORDER BY id DESC`
            )
            .all(p.article_id)
        );
      },
    }),
    defineTool({
      name: 'restore_article_revision',
      label: '恢复修订版本',
      description:
        '把文章恢复到指定修订版本(只还原标题/摘要/正文/封面,不动状态和分类;恢复前会自动快照当前版)。执行前必须得到用户的明确确认。',
      parameters: Type.Object({
        article_id: Type.Number({ description: '文章 ID' }),
        revision_id: Type.Number({ description: '修订版本 ID(可先用 list_article_revisions 查看)' }),
      }),
      execute: async (_id, p) => {
        const revision = db
          .prepare(`SELECT * FROM article_revisions WHERE id = ? AND article_id = ?`)
          .get(p.revision_id, p.article_id) as
          | { id: number; title: string; slug: string; summary: string; content: string; cover_image: string }
          | undefined;
        if (!revision) throw new Error('修订版本不存在,可先用 list_article_revisions 查看');
        snapshotArticle(p.article_id, `${user.username}(AI)`);
        const restore = (withSlug: boolean) =>
          db
            .prepare(
              `UPDATE articles SET title = ?, ${withSlug ? 'slug = ?,' : ''} summary = ?, content = ?, cover_image = ?, updated_at = datetime('now') WHERE id = ?`
            )
            .run(
              ...(withSlug
                ? [revision.title, revision.slug, revision.summary, revision.content, revision.cover_image, p.article_id]
                : [revision.title, revision.summary, revision.content, revision.cover_image, p.article_id])
            );
        try {
          restore(true);
        } catch {
          restore(false);
        }
        auditAi(user, 'restore_article_revision', `article:${p.article_id}`, `revision:${revision.id}`);
        return ok(articleWithTags(db.prepare(`${ARTICLE_LIST_SQL} WHERE a.id = ?`).get(p.article_id) as { id: number }));
      },
    })
  );

  // ---- 分类 ----
  tools.push(
    defineTool({
      name: 'list_categories',
      label: '分类列表',
      description: '获取所有分类(含每个分类下的文章数)。',
      parameters: Type.Object({}),
      execute: async () =>
        ok(
          db
            .prepare(
              `SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id) AS article_count
               FROM categories c ORDER BY c.sort_order, c.id`
            )
            .all()
        ),
    }),
    defineTool({
      name: 'create_category',
      label: '新建分类',
      description: '创建一个文章分类。',
      parameters: Type.Object({
        name: Type.String({ description: '分类名称(必填)' }),
        slug: Type.Optional(Type.String({ description: '留空自动生成' })),
        description: Type.Optional(Type.String()),
        parent_id: Type.Optional(Type.Number({ description: '父分类 ID' })),
        sort_order: Type.Optional(Type.Number()),
      }),
      execute: async (_id, p) => {
        try {
          const id = db
            .prepare(`INSERT INTO categories (name, slug, description, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)`)
            .run(p.name, p.slug ? slugify(p.slug) : slugify(p.name), p.description ?? '', p.parent_id ?? null, p.sort_order ?? 0)
            .lastInsertRowid as number;
          auditAi(user, 'create_category', `category:${id}`, p.name);
          return ok(db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id));
        } catch {
          throw new Error('分类 slug 已存在');
        }
      },
    }),
    defineTool({
      name: 'update_category',
      label: '更新分类',
      description: '更新分类信息,只传需要修改的字段。',
      parameters: Type.Object({
        id: Type.Number({ description: '分类 ID(必填)' }),
        name: Type.Optional(Type.String()),
        slug: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        sort_order: Type.Optional(Type.Number()),
      }),
      execute: async (_id, p) => {
        try {
          const result = db
            .prepare(
              `UPDATE categories SET
                 name = COALESCE(?, name),
                 slug = COALESCE(?, slug),
                 description = COALESCE(?, description),
                 sort_order = COALESCE(?, sort_order)
               WHERE id = ?`
            )
            .run(p.name ?? null, p.slug ? slugify(p.slug) : null, p.description ?? null, p.sort_order ?? null, p.id);
          if (result.changes === 0) throw new Error('分类不存在');
          auditAi(user, 'update_category', `category:${p.id}`);
          return ok(db.prepare(`SELECT * FROM categories WHERE id = ?`).get(p.id));
        } catch (err) {
          if (err instanceof Error && err.message === '分类不存在') throw err;
          throw new Error('分类 slug 已存在');
        }
      },
    }),
    defineTool({
      name: 'delete_category',
      label: '删除分类',
      description: '删除一个分类(分类下还有文章时无法删除)。删除前必须得到用户的明确确认。',
      parameters: Type.Object({
        id: Type.Number({ description: '分类 ID' }),
      }),
      execute: async (_id, p) => {
        const inUse = db.prepare(`SELECT COUNT(*) AS c FROM articles WHERE category_id = ?`).get(p.id) as { c: number };
        if (inUse.c > 0) throw new Error(`该分类下还有 ${inUse.c} 篇文章,无法删除;可先把文章移到其他分类`);
        const result = db.prepare(`DELETE FROM categories WHERE id = ?`).run(p.id);
        if (result.changes === 0) throw new Error('分类不存在');
        auditAi(user, 'delete_category', `category:${p.id}`);
        return ok({ ok: true });
      },
    })
  );

  // ---- 标签 ----
  tools.push(
    defineTool({
      name: 'list_tags',
      label: '标签列表',
      description: '获取所有标签(含每个标签下的文章数)。',
      parameters: Type.Object({}),
      execute: async () =>
        ok(
          db
            .prepare(
              `SELECT t.*, (SELECT COUNT(*) FROM article_tags at WHERE at.tag_id = t.id) AS article_count
               FROM tags t ORDER BY t.id`
            )
            .all()
        ),
    }),
    defineTool({
      name: 'create_tag',
      label: '新建标签',
      description: '创建一个标签。',
      parameters: Type.Object({
        name: Type.String({ description: '标签名(必填)' }),
        slug: Type.Optional(Type.String()),
      }),
      execute: async (_id, p) => {
        try {
          const id = db
            .prepare(`INSERT INTO tags (name, slug) VALUES (?, ?)`)
            .run(p.name, p.slug ? slugify(p.slug) : slugify(p.name)).lastInsertRowid as number;
          auditAi(user, 'create_tag', `tag:${id}`, p.name);
          return ok(db.prepare(`SELECT * FROM tags WHERE id = ?`).get(id));
        } catch {
          throw new Error('标签名或 slug 已存在');
        }
      },
    }),
    defineTool({
      name: 'delete_tag',
      label: '删除标签',
      description: '删除一个标签(会同时解除与文章的关联)。删除前必须得到用户的明确确认。',
      parameters: Type.Object({
        id: Type.Number({ description: '标签 ID' }),
      }),
      execute: async (_id, p) => {
        const result = db.prepare(`DELETE FROM tags WHERE id = ?`).run(p.id);
        if (result.changes === 0) throw new Error('标签不存在');
        auditAi(user, 'delete_tag', `tag:${p.id}`);
        return ok({ ok: true });
      },
    })
  );

  // ---- 媒体库 ----
  tools.push(
    defineTool({
      name: 'delete_media',
      label: '删除媒体文件',
      description: '从媒体库永久删除一个文件(磁盘文件一并删除,不可恢复)。删除前必须得到用户的明确确认。',
      parameters: Type.Object({
        id: Type.Number({ description: '媒体文件 ID' }),
      }),
      execute: async (_id, p) => {
        const row = db.prepare(`SELECT filename, original_name FROM media WHERE id = ?`).get(p.id) as
          | { filename: string; original_name: string }
          | undefined;
        if (!row) throw new Error('文件不存在');
        db.prepare(`DELETE FROM media WHERE id = ?`).run(p.id);
        fs.rm(path.join(config.uploadDir, row.filename), { force: true }, () => {});
        auditAi(user, 'delete_media', `media:${p.id}`, row.original_name);
        return ok({ ok: true, deleted: row.original_name });
      },
    }),
    defineTool({
      name: 'list_media',
      label: '媒体列表',
      description: '分页查询媒体库文件(图片等),返回的 url 可直接用作文章封面图。',
      parameters: Type.Object({
        page: Type.Optional(Type.Number({ description: '页码,默认 1' })),
      }),
      execute: async (_id, p) => {
        const page = Math.max(1, p.page ?? 1);
        const pageSize = 24;
        const total = (db.prepare(`SELECT COUNT(*) AS c FROM media`).get() as { c: number }).c;
        const items = (
          db
            .prepare(
              `SELECT m.id, m.filename, m.original_name, m.mime_type, m.size, m.thumb_filename, m.created_at, u.display_name AS uploader_name
               FROM media m LEFT JOIN users u ON u.id = m.uploader_id
               ORDER BY m.id DESC LIMIT ? OFFSET ?`
            )
            .all(pageSize, (page - 1) * pageSize) as ({ filename: string; thumb_filename: string | null } & Record<string, unknown>)[]
        ).map((m) => ({ ...m, url: `/uploads/${m.filename}`, thumb_url: m.thumb_filename ? `/uploads/${m.thumb_filename}` : null }));
        return ok({ items, total, page, page_size: pageSize });
      },
    })
  );

  // ---- 站点设置 ----
  tools.push(
    defineTool({
      name: 'get_settings',
      label: '查看站点设置',
      description: '获取站点设置(站点名称、描述、关键词、ICP 备案号等)。',
      parameters: Type.Object({}),
      execute: async () => ok(getSafeSettings(false)),
    })
  );

  if (user.role === 'admin') {
    tools.push(
      defineTool({
        name: 'update_settings',
        label: '修改站点设置',
        description: '修改站点设置,只传需要修改的字段(仅管理员)。',
        parameters: Type.Object({
          site_name: Type.Optional(Type.String({ description: '站点名称' })),
          site_description: Type.Optional(Type.String({ description: '站点描述' })),
          site_keywords: Type.Optional(Type.String({ description: '关键词,逗号分隔' })),
          icp_number: Type.Optional(Type.String({ description: 'ICP 备案号' })),
        }),
        execute: async (_id, p) => {
          const upsert = db.prepare(
            `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
          );
          const changed: string[] = [];
          for (const [key, value] of Object.entries(p)) {
            if (typeof value === 'string') {
              upsert.run(key, value);
              changed.push(key);
            }
          }
          auditAi(user, 'update_settings', '', changed.join(','));
          return ok(getSafeSettings(false));
        },
      }),
      defineTool({
        name: 'list_users',
        label: '用户列表',
        description: '获取所有后台用户(仅管理员)。',
        parameters: Type.Object({}),
        execute: async () =>
          ok(db.prepare(`SELECT id, username, email, display_name, role, status, created_at FROM users ORDER BY id`).all()),
      }),
      defineTool({
        name: 'create_user',
        label: '新建用户',
        description: '创建后台用户(仅管理员)。角色:admin(管理员)/ editor(编辑)/ viewer(只读)。',
        parameters: Type.Object({
          username: Type.String({ description: '用户名(必填)' }),
          email: Type.String({ description: '邮箱(必填)' }),
          password: Type.String({ description: '密码,至少 6 位(必填)' }),
          display_name: Type.Optional(Type.String({ description: '姓名' })),
          role: Type.Optional(Type.String({ description: 'admin / editor / viewer,默认 editor' })),
        }),
        execute: async (_id, p) => {
          const role = p.role ?? 'editor';
          if (!['admin', 'editor', 'viewer'].includes(role)) throw new Error('角色无效');
          if (p.password.length < 6) throw new Error('密码至少 6 位');
          try {
            const id = db
              .prepare(`INSERT INTO users (username, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`)
              .run(p.username, p.email, hashPassword(p.password), p.display_name ?? '', role).lastInsertRowid as number;
            auditAi(user, 'create_user', `user:${id}`, p.username);
            return ok(db.prepare(`SELECT id, username, email, display_name, role, status FROM users WHERE id = ?`).get(id));
          } catch {
            throw new Error('用户名或邮箱已存在');
          }
        },
      }),
      defineTool({
        name: 'update_user',
        label: '更新用户',
        description: '更新用户信息(仅管理员):邮箱、姓名、角色、状态(active/disabled)、重置密码。不能降级或禁用自己。',
        parameters: Type.Object({
          id: Type.Number({ description: '用户 ID(必填)' }),
          email: Type.Optional(Type.String()),
          display_name: Type.Optional(Type.String()),
          role: Type.Optional(Type.String({ description: 'admin / editor / viewer' })),
          status: Type.Optional(Type.String({ description: 'active / disabled' })),
          password: Type.Optional(Type.String({ description: '重置密码,至少 6 位' })),
        }),
        execute: async (_id, p) => {
          const existing = db.prepare(`SELECT id FROM users WHERE id = ?`).get(p.id);
          if (!existing) throw new Error('用户不存在');
          if (p.role && !['admin', 'editor', 'viewer'].includes(p.role)) throw new Error('角色无效');
          if (p.status && !['active', 'disabled'].includes(p.status)) throw new Error('状态无效');
          if (p.id === user.id && ((p.role && p.role !== 'admin') || p.status === 'disabled')) {
            throw new Error('不能降级或禁用当前登录的账号');
          }
          if (p.password && p.password.length < 6) throw new Error('密码至少 6 位');
          try {
            db.prepare(
              `UPDATE users SET
                 email = COALESCE(?, email),
                 display_name = COALESCE(?, display_name),
                 role = COALESCE(?, role),
                 status = COALESCE(?, status),
                 updated_at = datetime('now')
               WHERE id = ?`
            ).run(p.email ?? null, p.display_name ?? null, p.role ?? null, p.status ?? null, p.id);
            if (p.password) db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(p.password), p.id);
            auditAi(user, 'update_user', `user:${p.id}`);
            return ok(db.prepare(`SELECT id, username, email, display_name, role, status FROM users WHERE id = ?`).get(p.id));
          } catch {
            throw new Error('邮箱已被占用');
          }
        },
      }),
      defineTool({
        name: 'delete_user',
        label: '删除用户',
        description: '删除后台用户(仅管理员,不能删除自己;名下有文章时无法删除)。删除前必须得到用户的明确确认。',
        parameters: Type.Object({
          id: Type.Number({ description: '用户 ID' }),
        }),
        execute: async (_id, p) => {
          if (p.id === user.id) throw new Error('不能删除当前登录的账号');
          const hasArticles = db.prepare(`SELECT COUNT(*) AS c FROM articles WHERE author_id = ?`).get(p.id) as { c: number };
          if (hasArticles.c > 0) throw new Error('该用户名下存在文章,请先转移或删除文章,或将其禁用');
          const result = db.prepare(`DELETE FROM users WHERE id = ?`).run(p.id);
          if (result.changes === 0) throw new Error('用户不存在');
          auditAi(user, 'delete_user', `user:${p.id}`);
          return ok({ ok: true });
        },
      }),
      defineTool({
        name: 'list_audit_logs',
        label: '审计日志',
        description: '分页查询审计日志(仅管理员),支持按操作类型、用户名、关键词筛选。AI 助手的操作 action 以 ai: 前缀标识。',
        parameters: Type.Object({
          page: Type.Optional(Type.Number({ description: '页码,默认 1' })),
          action: Type.Optional(Type.String({ description: '操作类型,如 login / create_article / ai:update_article' })),
          username: Type.Optional(Type.String({ description: '按用户名筛选' })),
          q: Type.Optional(Type.String({ description: '在操作对象/详情中搜索关键词' })),
        }),
        execute: async (_id, p) => {
          const page = Math.max(1, p.page ?? 1);
          const pageSize = 50;
          const conditions: string[] = [];
          const params: string[] = [];
          if (p.action) {
            conditions.push('action = ?');
            params.push(p.action);
          }
          if (p.username) {
            conditions.push('username = ?');
            params.push(p.username);
          }
          if (p.q) {
            conditions.push('(target LIKE ? OR detail LIKE ?)');
            params.push(`%${p.q}%`, `%${p.q}%`);
          }
          const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
          const total = (db.prepare(`SELECT COUNT(*) AS c FROM audit_logs${where}`).get(...params) as { c: number }).c;
          const items = db
            .prepare(`SELECT * FROM audit_logs${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
            .all(...params, pageSize, (page - 1) * pageSize);
          return ok({ items, total, page, page_size: pageSize });
        },
      })
    );
  }

  return tools;
}
