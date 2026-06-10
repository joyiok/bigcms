import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { hashPassword } from './password.js';

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
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL,
  uploader_id   INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
`);

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

  const insertSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
  insertSetting.run('site_name', 'BigCMS 企业站点');
  insertSetting.run('site_description', '基于 TypeScript 的企业级内容管理系统');
  insertSetting.run('site_keywords', 'CMS,企业,内容管理');
  insertSetting.run('icp_number', '');

  console.log('[db] 初始数据已写入(admin/admin123, editor/editor123)');
}
