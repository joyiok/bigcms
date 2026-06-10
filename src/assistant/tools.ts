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
import { SITE_COPY_DEFAULTS, SITE_COPY_LABELS } from '../site-copy.js';
import { browsePage, serpSearch } from '../brightdata.js';
import { qccFuzzySearch } from '../qcc.js';

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

  // ---- 联系人 / 销售线索 ----
  const LEAD_STAGES = ['pending', 'contacted', 'qualified', 'converted', 'lost'];
  const CONTACT_COLS = 'id, name, email, phone, company, message, status, stage, next_follow_up_at, source, created_at';
  tools.push(
    defineTool({
      name: 'list_contacts',
      label: '联系人 / 销售线索列表',
      description:
        '查询前台联系表单提交的销售线索。支持按收件状态(new/read/archived)、线索阶段(pending 待跟进 / contacted 已联系 / qualified 已确认意向 / converted 已成交 / lost 已流失)、逾期待办(overdue)和关键词筛选。返回字段含 stage(阶段)与 next_follow_up_at(下次回访日期)。',
      parameters: Type.Object({
        page: Type.Optional(Type.Number({ description: '页码,默认 1' })),
        page_size: Type.Optional(Type.Number({ description: '每页条数,默认 20' })),
        status: Type.Optional(Type.String({ description: '收件状态:new / read / archived' })),
        stage: Type.Optional(Type.String({ description: `线索阶段:${LEAD_STAGES.join(' / ')}` })),
        source: Type.Optional(Type.String({ description: '线索来源:form(前台表单)/ ai(AI 主动开发)' })),
        overdue: Type.Optional(Type.Boolean({ description: '仅看逾期线索(回访日期已过且未成交/流失)' })),
        q: Type.Optional(Type.String({ description: '搜索姓名/电话/邮箱/公司/留言' })),
      }),
      execute: async (_id, p) => {
        const page = Math.max(1, p.page ?? 1);
        const pageSize = Math.min(100, Math.max(1, p.page_size ?? 20));
        const conditions: string[] = [];
        const params: string[] = [];
        if (p.status && ['new', 'read', 'archived'].includes(p.status)) {
          conditions.push('status = ?');
          params.push(p.status);
        }
        if (p.stage && LEAD_STAGES.includes(p.stage)) {
          conditions.push('stage = ?');
          params.push(p.stage);
        }
        if (p.source && ['form', 'ai'].includes(p.source)) {
          conditions.push('source = ?');
          params.push(p.source);
        }
        if (p.overdue) {
          conditions.push(`next_follow_up_at != '' AND next_follow_up_at < date('now', 'localtime') AND stage NOT IN ('converted', 'lost')`);
        }
        if (p.q) {
          conditions.push('(name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ? OR message LIKE ?)');
          const kw = `%${p.q.slice(0, 100)}%`;
          params.push(kw, kw, kw, kw, kw);
        }
        const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
        const total = (db.prepare(`SELECT COUNT(*) AS c FROM contacts${where}`).get(...params) as { c: number }).c;
        const items = db
          .prepare(`SELECT ${CONTACT_COLS} FROM contacts${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
          .all(...params, pageSize, (page - 1) * pageSize);
        return ok({ items, total, page, page_size: pageSize });
      },
    }),
    defineTool({
      name: 'get_contact',
      label: '线索详情',
      description: '查看单条销售线索的完整信息与全部跟进记录(时间线,新→旧)。',
      parameters: Type.Object({
        id: Type.Number({ description: '联系人 / 线索 ID' }),
      }),
      execute: async (_id, p) => {
        const row = db.prepare(`SELECT ${CONTACT_COLS} FROM contacts WHERE id = ?`).get(p.id);
        if (!row) throw new Error('联系人记录不存在');
        const notes = db
          .prepare(`SELECT id, author, note, created_at FROM contact_notes WHERE contact_id = ? ORDER BY id DESC`)
          .all(p.id);
        return ok({ ...row, notes });
      },
    }),
    defineTool({
      name: 'lead_stats',
      label: '线索漏斗统计',
      description: '按阶段统计销售线索数量(漏斗视图),并返回逾期未跟进数量,用于汇报与复盘。',
      parameters: Type.Object({}),
      execute: async () => {
        const byStage = Object.fromEntries(LEAD_STAGES.map((s) => [s, 0]));
        for (const r of db.prepare(`SELECT stage, COUNT(*) AS c FROM contacts GROUP BY stage`).all() as { stage: string; c: number }[]) {
          byStage[r.stage] = r.c;
        }
        const overdue = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM contacts WHERE next_follow_up_at != '' AND next_follow_up_at < date('now', 'localtime') AND stage NOT IN ('converted', 'lost')`
            )
            .get() as { c: number }
        ).c;
        const total = (db.prepare(`SELECT COUNT(*) AS c FROM contacts`).get() as { c: number }).c;
        return ok({ total, by_stage: byStage, overdue });
      },
    })
  );

  if (user.role !== 'viewer') {
    tools.push(
      defineTool({
        name: 'update_contact',
        label: '更新线索',
        description:
          '更新销售线索:收件状态(status)、线索阶段(stage)、下次回访日期(next_follow_up_at,YYYY-MM-DD,空字符串清除)。至少提供一个字段。',
        parameters: Type.Object({
          id: Type.Number({ description: '联系人 / 线索 ID(必填)' }),
          status: Type.Optional(Type.String({ description: '收件状态:new / read / archived' })),
          stage: Type.Optional(Type.String({ description: `线索阶段:${LEAD_STAGES.join(' / ')}` })),
          next_follow_up_at: Type.Optional(Type.String({ description: '下次回访日期 YYYY-MM-DD,空字符串清除' })),
        }),
        execute: async (_id, p) => {
          const sets: string[] = [];
          const params: string[] = [];
          if (p.status !== undefined) {
            if (!['new', 'read', 'archived'].includes(p.status)) throw new Error('状态无效');
            sets.push('status = ?');
            params.push(p.status);
          }
          if (p.stage !== undefined) {
            if (!LEAD_STAGES.includes(p.stage)) throw new Error(`线索阶段无效,可选:${LEAD_STAGES.join(' / ')}`);
            sets.push('stage = ?');
            params.push(p.stage);
          }
          if (p.next_follow_up_at !== undefined) {
            if (p.next_follow_up_at !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(p.next_follow_up_at)) {
              throw new Error('回访日期格式应为 YYYY-MM-DD');
            }
            sets.push('next_follow_up_at = ?');
            params.push(p.next_follow_up_at);
          }
          if (!sets.length) throw new Error('没有可更新的字段');
          const result = db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...params, p.id);
          if (!result.changes) throw new Error('联系人记录不存在');
          auditAi(user, 'update_contact', `contact:${p.id}`, sets.map((s, i) => `${s.split(' ')[0]}=${params[i]}`).join(' '));
          return ok(db.prepare(`SELECT ${CONTACT_COLS} FROM contacts WHERE id = ?`).get(p.id));
        },
      }),
      defineTool({
        name: 'create_lead',
        label: '创建销售线索',
        description:
          '把主动开发的潜在客户(通常是一家公司)存入线索池,来源记为 ai。创建前必须先用 list_contacts 按公司名/电话查重,避免重复线索。message 字段写清线索背景:目标公司是做什么的、为什么是潜在客户、信息来源。',
        parameters: Type.Object({
          name: Type.String({ description: '联系人姓名;没有具体联系人时填公司名(必填)' }),
          company: Type.Optional(Type.String({ description: '公司名称' })),
          phone: Type.Optional(Type.String({ description: '电话' })),
          email: Type.Optional(Type.String({ description: '邮箱' })),
          message: Type.String({ description: '线索背景与开发依据(必填):公司业务、判断为潜在客户的理由、信息来源' }),
          next_follow_up_at: Type.Optional(Type.String({ description: '计划首次触达日期 YYYY-MM-DD' })),
        }),
        execute: async (_id, p) => {
          const name = p.name.trim().slice(0, 80);
          const message = p.message.trim().slice(0, 2000);
          if (!name) throw new Error('联系人/公司名不能为空');
          if (!message) throw new Error('线索背景不能为空');
          if (p.next_follow_up_at && !/^\d{4}-\d{2}-\d{2}$/.test(p.next_follow_up_at)) {
            throw new Error('首次触达日期格式应为 YYYY-MM-DD');
          }
          const inserted = db
            .prepare(
              `INSERT INTO contacts (name, email, phone, company, message, status, stage, next_follow_up_at, source)
               VALUES (?, ?, ?, ?, ?, 'read', 'pending', ?, 'ai')`
            )
            .run(
              name,
              (p.email ?? '').trim().slice(0, 120),
              (p.phone ?? '').trim().slice(0, 40),
              (p.company ?? '').trim().slice(0, 120),
              message,
              p.next_follow_up_at ?? ''
            );
          auditAi(user, 'create_lead', `contact:${inserted.lastInsertRowid}`, `${name}${p.company ? ` (${p.company})` : ''}`);
          return ok(db.prepare(`SELECT ${CONTACT_COLS} FROM contacts WHERE id = ?`).get(inserted.lastInsertRowid));
        },
      }),
      defineTool({
        name: 'add_contact_note',
        label: '添加跟进记录',
        description: '为某条销售线索追加一条跟进记录(沟通纪要、客户反馈、下一步行动等),会记入线索时间线。',
        parameters: Type.Object({
          id: Type.Number({ description: '联系人 / 线索 ID(必填)' }),
          note: Type.String({ description: '跟进内容(必填,≤2000 字)' }),
        }),
        execute: async (_id, p) => {
          const note = p.note.trim().slice(0, 2000);
          if (!note) throw new Error('跟进内容不能为空');
          const contact = db.prepare(`SELECT id FROM contacts WHERE id = ?`).get(p.id);
          if (!contact) throw new Error('联系人记录不存在');
          const inserted = db
            .prepare(`INSERT INTO contact_notes (contact_id, author, note) VALUES (?, ?, ?)`)
            .run(p.id, user.display_name || user.username, note);
          auditAi(user, 'add_contact_note', `contact:${p.id}`, note.slice(0, 100));
          return ok(db.prepare(`SELECT id, author, note, created_at FROM contact_notes WHERE id = ?`).get(inserted.lastInsertRowid));
        },
      }),
      defineTool({
        name: 'delete_contact',
        label: '删除联系人',
        description: '删除联系人记录。删除前须向用户确认。',
        parameters: Type.Object({
          id: Type.Number({ description: '联系人 ID(必填)' }),
        }),
        execute: async (_id, p) => {
          const result = db.prepare(`DELETE FROM contacts WHERE id = ?`).run(p.id);
          if (!result.changes) throw new Error('联系人记录不存在');
          auditAi(user, 'delete_contact', `contact:${p.id}`);
          return ok({ ok: true });
        },
      })
    );
  }

  // ---- 站点设置 ----
  tools.push(
    defineTool({
      name: 'get_settings',
      label: '查看站点设置',
      description: '获取站点设置,含前台官网全部文案(站点名称/wordmark、描述、导航、首页区块、页脚署名等)。',
      parameters: Type.Object({}),
      execute: async () => ok(getSafeSettings(false)),
    })
  );

  if (user.role === 'admin') {
    tools.push(
      defineTool({
        name: 'update_settings',
        label: '修改站点设置',
        description: '修改站点设置与前台官网文案,只传需要修改的字段(仅管理员)。',
        parameters: Type.Object(
          Object.fromEntries(
            Object.keys(SITE_COPY_DEFAULTS).map((key) => [
              key,
              Type.Optional(Type.String({ description: SITE_COPY_LABELS[key] ?? key })),
            ])
          )
        ),
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

  // ---- Bright Data 网页检索(编辑及以上) ----
  if (user.role !== 'viewer') {
    tools.push(
      defineTool({
        name: 'web_search',
        label: '搜索引擎检索',
        description:
          '通过 Bright Data SERP API 获取 Google/Bing/DuckDuckGo 结构化搜索结果,用于竞品调研、事实核查、SEO 参考。需先在后台配置 Bright Data API Key 与 SERP Zone。',
        parameters: Type.Object({
          query: Type.String({ description: '搜索关键词(必填)' }),
          engine: Type.Optional(Type.String({ description: 'google / bing / duckduckgo,默认 google' })),
          hl: Type.Optional(Type.String({ description: '界面语言,默认 zh-CN' })),
          gl: Type.Optional(Type.String({ description: '地区,默认 cn(Google)' })),
          data_format: Type.Optional(
            Type.String({ description: 'parsed_light(默认,前 10 条有机结果) / json / markdown' })
          ),
        }),
        execute: async (_id, p) => {
          const engine = (p.engine ?? 'google') as 'google' | 'bing' | 'duckduckgo';
          if (!['google', 'bing', 'duckduckgo'].includes(engine)) throw new Error('engine 无效');
          const dataFormat = (p.data_format ?? 'parsed_light') as 'parsed_light' | 'markdown' | 'json';
          if (!['parsed_light', 'markdown', 'json'].includes(dataFormat)) throw new Error('data_format 无效');
          const data = await serpSearch({
            query: p.query,
            engine,
            hl: p.hl,
            gl: p.gl,
            dataFormat,
          });
          auditAi(user, 'web_search', '', `${engine}:${p.query.slice(0, 80)}`);
          return ok({ query: p.query, engine, data });
        },
      }),
      defineTool({
        name: 'browse_webpage',
        label: '浏览器抓取网页',
        description:
          '用服务器无头浏览器(Puppeteer 内置 Chromium)打开 URL 并提取页面标题与正文(适合 JS 渲染站点)。仅用于合法公开信息采集,勿抓取用户隐私或违反目标站条款。',
        parameters: Type.Object({
          url: Type.String({ description: '要打开的 https 页面 URL(必填)' }),
          max_chars: Type.Optional(Type.Number({ description: '返回正文最大字符数,默认 12000' })),
        }),
        execute: async (_id, p) => {
          const data = await browsePage({ url: p.url, maxChars: p.max_chars });
          auditAi(user, 'browse_webpage', '', p.url.slice(0, 200));
          return ok(data);
        },
      }),
      defineTool({
        name: 'search_companies',
        label: '企查查企业搜索',
        description:
          '通过企查查开放平台 API 886(企业模糊搜索)按企业名、人名、地址等关键词查询匹配企业,返回名称、统一社会信用代码、法人、状态、成立日期、注册地址等。需配置 AppKey 与 SecretKey。',
        parameters: Type.Object({
          search_key: Type.String({ description: '搜索关键词(企业名、人名、产品名、地址等,必填)' }),
          page_index: Type.Optional(Type.Number({ description: '页码,默认 1' })),
          page_size: Type.Optional(Type.Number({ description: '每页条数,可选,最大 20' })),
          province_code: Type.Optional(Type.String({ description: '省份行政区划代码(6 位,可选)' })),
          city_code: Type.Optional(Type.String({ description: '城市行政区划代码(6 位,可选)' })),
        }),
        execute: async (_id, p) => {
          const data = await qccFuzzySearch({
            searchKey: p.search_key,
            pageIndex: p.page_index,
            pageSize: p.page_size,
            provinceCode: p.province_code,
            cityCode: p.city_code,
          });
          auditAi(user, 'search_companies', '', p.search_key.slice(0, 80));
          return ok({ search_key: p.search_key, ...data });
        },
      })
    );
  }

  return tools;
}
