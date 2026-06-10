import { Router } from 'express';
import { db } from '../db.js';
import { audit, requireAuth, requireRole } from '../auth.js';

export const contactsRouter = Router();

const CONTACT_STATUSES = new Set(['new', 'read', 'archived']);

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
  if (req.query.q) {
    conditions.push('(name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ? OR message LIKE ?)');
    const kw = `%${String(req.query.q).slice(0, 100)}%`;
    params.push(kw, kw, kw, kw, kw);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM contacts${where}`).get(...params) as { c: number }).c;
  const items = db
    .prepare(`SELECT id, name, email, phone, company, message, status, ip, created_at FROM contacts${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
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
  res.json(row);
});

contactsRouter.put('/:id', requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  if (!CONTACT_STATUSES.has(String(status))) {
    res.status(400).json({ error: '状态无效' });
    return;
  }
  const result = db.prepare(`UPDATE contacts SET status = ? WHERE id = ?`).run(status, id);
  if (!result.changes) {
    res.status(404).json({ error: '联系人记录不存在' });
    return;
  }
  audit(req, 'update_contact', `contact:${id}`, String(status));
  res.json(db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(id));
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
