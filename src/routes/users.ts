import { Router } from 'express';
import { db } from '../db.js';
import { audit, requireAuth, requireRole } from '../auth.js';
import { hashPassword } from '../password.js';

export const usersRouter = Router();

usersRouter.use(requireAuth, requireRole('admin'));

const SAFE_COLS = `id, username, email, display_name, role, status, created_at, updated_at`;

usersRouter.get('/', (_req, res) => {
  const users = db.prepare(`SELECT ${SAFE_COLS} FROM users ORDER BY id`).all();
  res.json({ items: users });
});

usersRouter.post('/', (req, res) => {
  const { username, email, password, display_name = '', role = 'editor' } = req.body ?? {};
  if (!username || !email || !password || String(password).length < 6) {
    res.status(400).json({ error: '用户名、邮箱必填,密码至少 6 位' });
    return;
  }
  if (!['admin', 'editor', 'viewer'].includes(role)) {
    res.status(400).json({ error: '角色无效' });
    return;
  }
  try {
    const id = db
      .prepare(`INSERT INTO users (username, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`)
      .run(username, email, hashPassword(password), display_name, role).lastInsertRowid;
    audit(req, 'create_user', `user:${id}`, username);
    res.status(201).json(db.prepare(`SELECT ${SAFE_COLS} FROM users WHERE id = ?`).get(id));
  } catch {
    res.status(409).json({ error: '用户名或邮箱已存在' });
  }
});

usersRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT ${SAFE_COLS} FROM users WHERE id = ?`).get(id) as { role: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  const { email, display_name, role, status, password } = req.body ?? {};
  if (role && !['admin', 'editor', 'viewer'].includes(role)) {
    res.status(400).json({ error: '角色无效' });
    return;
  }
  if (status && !['active', 'disabled'].includes(status)) {
    res.status(400).json({ error: '状态无效' });
    return;
  }
  if (id === req.user!.id && ((role && role !== 'admin') || status === 'disabled')) {
    res.status(400).json({ error: '不能降级或禁用自己的账号' });
    return;
  }
  try {
    db.prepare(
      `UPDATE users SET
         email = COALESCE(?, email),
         display_name = COALESCE(?, display_name),
         role = COALESCE(?, role),
         status = COALESCE(?, status),
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(email ?? null, display_name ?? null, role ?? null, status ?? null, id);
    if (password) {
      if (String(password).length < 6) {
        res.status(400).json({ error: '密码至少 6 位' });
        return;
      }
      db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(password), id);
    }
    audit(req, 'update_user', `user:${id}`);
    res.json(db.prepare(`SELECT ${SAFE_COLS} FROM users WHERE id = ?`).get(id));
  } catch {
    res.status(409).json({ error: '邮箱已被占用' });
  }
});

usersRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) {
    res.status(400).json({ error: '不能删除自己的账号' });
    return;
  }
  const hasArticles = db.prepare(`SELECT COUNT(*) AS c FROM articles WHERE author_id = ?`).get(id) as { c: number };
  if (hasArticles.c > 0) {
    res.status(400).json({ error: '该用户名下存在文章,请先转移或删除文章,或将其禁用' });
    return;
  }
  const result = db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  audit(req, 'delete_user', `user:${id}`);
  res.json({ ok: true });
});
