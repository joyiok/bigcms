import { Router } from 'express';
import { db } from '../db.js';
import { audit, requireAuth, signToken } from '../auth.js';
import { hashPassword, verifyPassword } from '../password.js';

export const authRouter = Router();

/** 登录失败滑动窗口限速:同一 IP+账号 15 分钟内最多失败 10 次 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map<string, number[]>();

function pruneFailures(key: string): number[] {
  const now = Date.now();
  const list = (loginFailures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length) loginFailures.set(key, list);
  else loginFailures.delete(key);
  return list;
}

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    res.status(400).json({ error: '请输入用户名和密码' });
    return;
  }
  const attempted = String(username).slice(0, 64);
  const rateKey = `${req.ip}|${attempted.toLowerCase()}`;
  if (pruneFailures(rateKey).length >= LOGIN_MAX_FAILURES) {
    res.status(429).json({ error: '失败次数过多,请 15 分钟后再试' });
    return;
  }
  const user = db
    .prepare(`SELECT id, username, display_name, email, role, status, password_hash FROM users WHERE username = ? OR email = ?`)
    .get(username, username) as
    | { id: number; username: string; display_name: string; email: string; role: string; status: string; password_hash: string }
    | undefined;

  if (!user || !verifyPassword(password, user.password_hash)) {
    loginFailures.set(rateKey, [...pruneFailures(rateKey), Date.now()]);
    db.prepare(`INSERT INTO audit_logs (user_id, username, action, detail) VALUES (NULL, ?, 'login_failed', ?)`).run(
      attempted,
      `ip:${req.ip}`
    );
    res.status(401).json({ error: '用户名或密码错误' });
    return;
  }
  loginFailures.delete(rateKey);
  if (user.status !== 'active') {
    res.status(403).json({ error: '账号已被禁用' });
    return;
  }
  const { password_hash: _ph, ...safe } = user;
  db.prepare(`INSERT INTO audit_logs (user_id, username, action) VALUES (?, ?, 'login')`).run(user.id, user.username);
  res.json({ token: signToken(user.id), user: safe });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

authRouter.put('/password', requireAuth, (req, res) => {
  const { old_password, new_password } = req.body ?? {};
  if (!old_password || !new_password || String(new_password).length < 6) {
    res.status(400).json({ error: '新密码至少 6 位' });
    return;
  }
  const row = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(req.user!.id) as { password_hash: string };
  if (!verifyPassword(old_password, row.password_hash)) {
    res.status(400).json({ error: '原密码错误' });
    return;
  }
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(
    hashPassword(new_password),
    req.user!.id
  );
  audit(req, 'change_password');
  res.json({ ok: true });
});
