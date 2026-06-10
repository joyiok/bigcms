import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { hashPassword } from './password.js';
import { ensureSiteCopySettings } from './site-copy.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'bigcms.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'viewer')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  parent_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  slug       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS articles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  summary      TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT '',
  cover_image  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  author_id    INTEGER NOT NULL REFERENCES users(id),
  views        INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  scheduled_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

CREATE TABLE IF NOT EXISTS media (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  filename       TEXT NOT NULL UNIQUE,
  original_name  TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size           INTEGER NOT NULL,
  thumb_filename TEXT,
  uploader_id    INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS article_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  slug        TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  cover_image TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  category_id INTEGER,
  saved_by    TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username   TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  company    TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'archived')),
  stage      TEXT NOT NULL DEFAULT 'pending',
  next_follow_up_at TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'form',
  ip         TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  author     TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_revisions_article ON article_revisions(article_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at);
CREATE INDEX IF NOT EXISTS idx_contact_notes_contact ON contact_notes(contact_id);
`);

/** 修订历史:每篇文章保留的最大版本数 */
const MAX_REVISIONS = 20;

/** 在文章被修改前快照当前版本(供修订历史/恢复使用),并裁剪到最近 N 版 */
export function snapshotArticle(articleId: number, savedBy: string): void {
  const row = db
    .prepare(`SELECT title, slug, summary, content, cover_image, status, category_id FROM articles WHERE id = ?`)
    .get(articleId) as
    | { title: string; slug: string; summary: string; content: string; cover_image: string; status: string; category_id: number | null }
    | undefined;
  if (!row) return;
  db.prepare(
    `INSERT INTO article_revisions (article_id, title, slug, summary, content, cover_image, status, category_id, saved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(articleId, row.title, row.slug, row.summary, row.content, row.cover_image, row.status, row.category_id, savedBy);
  db.prepare(
    `DELETE FROM article_revisions WHERE article_id = ?
       AND id NOT IN (SELECT id FROM article_revisions WHERE article_id = ? ORDER BY id DESC LIMIT ?)`
  ).run(articleId, articleId, MAX_REVISIONS);
}

// 迁移:为既有数据库补列(新建库已含,重复添加会抛错并被忽略)
try {
  db.exec(`ALTER TABLE articles ADD COLUMN scheduled_at TEXT`);
} catch {
  /* 列已存在 */
}
try {
  db.exec(`ALTER TABLE media ADD COLUMN thumb_filename TEXT`);
} catch {
  /* 列已存在 */
}
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN stage TEXT NOT NULL DEFAULT 'pending'`);
} catch {
  /* 列已存在 */
}
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN next_follow_up_at TEXT NOT NULL DEFAULT ''`);
} catch {
  /* 列已存在 */
}
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN source TEXT NOT NULL DEFAULT 'form'`);
} catch {
  /* 列已存在 */
}
// stage 列由上方迁移补齐后才能建索引,故不能放进主 schema
db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(stage)`);

ensureSiteCopySettings(db);
ensureProductsCategory(db);

// ---- 全文检索(FTS5 trigram,标题/摘要/正文;运行环境不支持时回退 LIKE) ----
let ftsAvailable = false;
try {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
       title, summary, content,
       content='articles', content_rowid='id', tokenize='trigram'
     )`
  );
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS articles_fts_ai AFTER INSERT ON articles BEGIN
      INSERT INTO articles_fts(rowid, title, summary, content) VALUES (new.id, new.title, new.summary, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS articles_fts_ad AFTER DELETE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, summary, content) VALUES ('delete', old.id, old.title, old.summary, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS articles_fts_au AFTER UPDATE OF title, summary, content ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, summary, content) VALUES ('delete', old.id, old.title, old.summary, old.content);
      INSERT INTO articles_fts(rowid, title, summary, content) VALUES (new.id, new.title, new.summary, new.content);
    END;
  `);
  // 启动时整体重建索引:外部 content 表无法可靠检测索引缺失(COUNT 读的是源表),
  // 且需覆盖首次启用、触发器缺失期间的历史写入;CMS 体量下重建为毫秒级。
  db.exec(`INSERT INTO articles_fts(articles_fts) VALUES ('rebuild')`);
  ftsAvailable = true;
} catch (err) {
  console.warn('[db] FTS5 不可用,搜索回退 LIKE:', err instanceof Error ? err.message : err);
}

/**
 * 文章关键词检索条件(要求文章表别名为 a)。
 * trigram 分词最短匹配 3 个字符:长查询走 FTS(含正文),短查询回退 LIKE。
 */
export function articleSearchCondition(q: string): { sql: string; params: string[] } {
  const kw = q.trim();
  if (ftsAvailable && [...kw].length >= 3) {
    // 整体作为短语查询,转义内部双引号,避免用户输入触碰 FTS 操作符语法
    return { sql: `a.id IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH ?)`, params: [`"${kw.replace(/"/g, '""')}"`] };
  }
  const like = `%${kw}%`;
  return { sql: `(a.title LIKE ? OR a.summary LIKE ? OR a.content LIKE ?)`, params: [like, like, like] };
}

/** 把任意可被 Date 解析的时间转为 SQLite UTC 格式(YYYY-MM-DD HH:MM:SS);空值返回 null,非法时间抛错 */
export function toUtcDateTime(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new Error('时间格式无效,请使用 ISO 8601(如 2026-06-12T09:00:00+08:00)');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function seed(): void {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  if (userCount.c > 0) return;

  const insertUser = db.prepare(
    `INSERT INTO users (username, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`
  );
  const adminId = insertUser.run('admin', 'admin@bigcms.local', hashPassword('admin123'), '系统管理员', 'admin')
    .lastInsertRowid as number;
  insertUser.run('editor', 'editor@bigcms.local', hashPassword('editor123'), '内容编辑', 'editor');

  const catId = db
    .prepare(`INSERT INTO categories (name, slug, description) VALUES ('公司新闻', 'company-news', '企业动态与公告')`)
    .run().lastInsertRowid as number;
  db.prepare(`INSERT INTO categories (name, slug, description) VALUES ('产品发布', 'product-release', '产品更新与发布说明')`).run();
  ensureProductsCategory(db);

  const tagId = db.prepare(`INSERT INTO tags (name, slug) VALUES ('公告', 'announcement')`).run()
    .lastInsertRowid as number;
  db.prepare(`INSERT INTO tags (name, slug) VALUES ('技术', 'tech')`).run();

  const articleId = db
    .prepare(
      `INSERT INTO articles (title, slug, summary, content, status, category_id, author_id, published_at)
       VALUES (?, ?, ?, ?, 'published', ?, ?, datetime('now'))`
    )
    .run(
      '欢迎使用 BigCMS 企业内容管理系统',
      'welcome-to-bigcms',
      'BigCMS 是一套基于 TypeScript 构建的企业级内容管理系统。',
      '# 欢迎使用 BigCMS\n\nBigCMS 提供文章管理、分类标签、媒体库、用户权限、审计日志等企业级功能。\n\n- 默认管理员:admin / admin123\n- 默认编辑:editor / editor123\n\n请登录后台后立即修改默认密码。',
      catId,
      adminId
    ).lastInsertRowid as number;
  db.prepare(`INSERT INTO article_tags (article_id, tag_id) VALUES (?, ?)`).run(articleId, tagId);

  console.log('[db] 初始数据已写入(admin/admin123, editor/editor123)');
}

/** 为既有数据库补全「商品」分类 */
export function ensureProductsCategory(db: { prepare: (sql: string) => { get: (...args: string[]) => unknown; run: (...args: string[]) => void } }): void {
  if (db.prepare(`SELECT 1 FROM categories WHERE slug = ?`).get('products')) return;
  db.prepare(`INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)`).run(
    '商品',
    'products',
    '产品与服务介绍',
    '10'
  );
}
