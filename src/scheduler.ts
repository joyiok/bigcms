/** 定时任务:定时发布文章 + 每日逾期线索提醒(钉钉/企微 webhook) */
import { db } from './db.js';
import { getSettings } from './settings.js';

const INTERVAL_MS = 30_000;
const REMINDER_CHECK_MS = 5 * 60 * 1000;

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

/**
 * 每日线索提醒:到达设定时刻后,把逾期/待跟进线索汇总推送到 webhook。
 * 消息体兼容钉钉与企业微信群机器人(msgtype=text);每天只发一次,
 * 发送状态记在 settings.lead_reminder_last_sent,跨重启不重复发。
 */
export async function sendLeadReminder(): Promise<void> {
  const settings = getSettings();
  const webhook = settings.lead_reminder_webhook?.trim();
  if (!webhook) return;
  const hour = Math.min(23, Math.max(0, Number(settings.lead_reminder_hour) || 9));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (now.getHours() < hour || settings.lead_reminder_last_sent === today) return;

  const markSent = () =>
    db.prepare(`INSERT INTO settings (key, value) VALUES ('lead_reminder_last_sent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(today);

  const overdue = db
    .prepare(
      `SELECT name, company, stage, next_follow_up_at FROM contacts
       WHERE stage IN ('pending', 'contacted', 'qualified') AND next_follow_up_at != '' AND next_follow_up_at < datetime('now')
       ORDER BY next_follow_up_at ASC LIMIT 10`
    )
    .all() as { name: string; company: string; stage: string; next_follow_up_at: string }[];
  const overdueTotal = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM contacts WHERE stage IN ('pending', 'contacted', 'qualified') AND next_follow_up_at != '' AND next_follow_up_at < datetime('now')`
      )
      .get() as { c: number }
  ).c;
  const pendingTotal = (db.prepare(`SELECT COUNT(*) AS c FROM contacts WHERE stage = 'pending'`).get() as { c: number }).c;

  if (!overdueTotal && !pendingTotal) {
    markSent();
    return;
  }

  const stageText: Record<string, string> = { pending: '待跟进', contacted: '已联系', qualified: '已确认意向' };
  const lines = overdue.map(
    (c) => `· ${c.name}${c.company ? `(${c.company})` : ''} [${stageText[c.stage] ?? c.stage}] 应回访 ${c.next_follow_up_at.slice(0, 10)}`
  );
  const content = [
    `【BigCMS 线索提醒】${today}`,
    `逾期未跟进 ${overdueTotal} 条,待首次触达 ${pendingTotal} 条。`,
    ...lines,
    overdueTotal > overdue.length ? `…等共 ${overdueTotal} 条逾期,详见后台「联系人」。` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    markSent();
    db.prepare(`INSERT INTO audit_logs (user_id, username, action, target, detail) VALUES (NULL, 'system', 'lead_reminder', '', ?)`).run(
      `逾期 ${overdueTotal},待跟进 ${pendingTotal}`
    );
    console.log(`[scheduler] 线索提醒已发送:逾期 ${overdueTotal},待跟进 ${pendingTotal}`);
  } catch (err) {
    // 发送失败不标记,下个周期重试
    console.warn(`[scheduler] 线索提醒发送失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function startScheduler(): void {
  publishDue();
  setInterval(publishDue, INTERVAL_MS).unref();
  void sendLeadReminder();
  setInterval(() => void sendLeadReminder(), REMINDER_CHECK_MS).unref();
}
