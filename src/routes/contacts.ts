import { Router } from 'express';
import { db } from '../db.js';
import { audit, requireAuth, requireRole } from '../auth.js';

export const contactsRouter = Router();

const CONTACT_STATUSES = new Set(['new', 'read', 'archived']);

/** 销售线索阶段:待跟进 → 已联系 → 已确认意向 → 已成交 / 已流失 */
export const LEAD_STAGES = ['pending', 'contacted', 'qualified', 'converted', 'lost'] as const;
const LEAD_STAGE_SET = new Set<string>(LEAD_STAGES);

const CONTACT_COLUMNS = 'id, name, email, phone, company, message, status, stage, next_follow_up_at, source, ip, created_at';

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

contactsRouter.use(requireAuth);

contactsRouter.get('/', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 20));
  const conditions: string[] = [];
  const params: string[] = [];
  if (req.query.status && CONTACT_STATUSES.has(String(req.query.status))) {
    conditions.push('status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.stage && LEAD_STAGE_SET.has(String(req.query.stage))) {
    conditions.push('stage = ?');
    params.push(String(req.query.stage));
  }
  // 逾期待办:回访日期已过且仍未到终态(成交/流失)
  if (req.query.overdue === '1') {
    conditions.push(`next_follow_up_at != '' AND next_follow_up_at < date('now', 'localtime') AND stage NOT IN ('converted', 'lost')`);
  }
  if (req.query.q) {
    conditions.push('(name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ? OR message LIKE ?)');
    const kw = `%${String(req.query.q).slice(0, 100)}%`;
    params.push(kw, kw, kw, kw, kw);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM contacts${where}`).get(...params) as { c: number }).c;
  const items = db
    .prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({ items, total, page, page_size: pageSize });
});

contactsRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: '联系人记录不存在' });
    return;
  }
  if (row.status === 'new') {
    db.prepare(`UPDATE contacts SET status = 'read' WHERE id = ?`).run(id);
    row.status = 'read';
  }
  const notes = db
    .prepare(`SELECT id, author, note, created_at FROM contact_notes WHERE contact_id = ? ORDER BY id DESC`)
    .all(id);
  res.json({ ...row, notes });
});

contactsRouter.put('/:id', requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const { status, stage, next_follow_up_at } = req.body ?? {};
  const sets: string[] = [];
  const params: string[] = [];
  if (status !== undefined) {
    if (!CONTACT_STATUSES.has(String(status))) {
      res.status(400).json({ error: '状态无效' });
      return;
    }
    sets.push('status = ?');
    params.push(String(status));
  }
  if (stage !== undefined) {
    if (!LEAD_STAGE_SET.has(String(stage))) {
      res.status(400).json({ error: `线索阶段无效,可选:${LEAD_STAGES.join(' / ')}` });
      return;
    }
    sets.push('stage = ?');
    params.push(String(stage));
  }
  if (next_follow_up_at !== undefined) {
    const v = String(next_follow_up_at);
    if (v !== '' && !isValidDate(v)) {
      res.status(400).json({ error: '回访日期格式应为 YYYY-MM-DD,或空字符串表示清除' });
      return;
    }
    sets.push('next_follow_up_at = ?');
    params.push(v);
  }
  if (!sets.length) {
    res.status(400).json({ error: '没有可更新的字段' });
    return;
  }
  const result = db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  if (!result.changes) {
    res.status(404).json({ error: '联系人记录不存在' });
    return;
  }
  audit(req, 'update_contact', `contact:${id}`, sets.map((s, i) => `${s.split(' ')[0]}=${params[i]}`).join(' '));
  res.json(db.prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = ?`).get(id));
});

/** 追加跟进记录(线索时间线) */
contactsRouter.post('/:id/notes', requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const note = String(req.body?.note ?? '').trim().slice(0, 2000);
  if (!note) {
    res.status(400).json({ error: '跟进内容不能为空' });
    return;
  }
  const contact = db.prepare(`SELECT id FROM contacts WHERE id = ?`).get(id);
  if (!contact) {
    res.status(404).json({ error: '联系人记录不存在' });
    return;
  }
  const authorName = req.user?.display_name || req.user?.username || '';
  const inserted = db.prepare(`INSERT INTO contact_notes (contact_id, author, note) VALUES (?, ?, ?)`).run(id, authorName, note);
  audit(req, 'add_contact_note', `contact:${id}`, note.slice(0, 100));
  res.status(201).json(db.prepare(`SELECT id, author, note, created_at FROM contact_notes WHERE id = ?`).get(inserted.lastInsertRowid));
});

contactsRouter.delete('/:id', requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare(`DELETE FROM contacts WHERE id = ?`).run(id);
  if (!result.changes) {
    res.status(404).json({ error: '联系人记录不存在' });
    return;
  }
  audit(req, 'delete_contact', `contact:${id}`);
  res.json({ ok: true });
});
