/** 定时发布:每 30 秒把到期的定时草稿转为已发布,并写审计日志 */
import { db } from './db.js';

const INTERVAL_MS = 30_000;

export function publishDue(): void {
  const due = db
    .prepare(`SELECT id, title FROM articles WHERE status = 'draft' AND scheduled_at IS NOT NULL AND scheduled_at <= datetime('now')`)
    .all() as { id: number; title: string }[];
  for (const article of due) {
    db.prepare(
      `UPDATE articles SET status = 'published',
         published_at = COALESCE(published_at, datetime('now')),
         scheduled_at = NULL,
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(article.id);
    db.prepare(`INSERT INTO audit_logs (user_id, username, action, target, detail) VALUES (NULL, 'system', 'scheduled_publish', ?, ?)`).run(
      `article:${article.id}`,
      article.title
    );
    console.log(`[scheduler] 定时发布: #${article.id} ${article.title}`);
  }
}

export function startScheduler(): void {
  publishDue();
  setInterval(publishDue, INTERVAL_MS).unref();
}
