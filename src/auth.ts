import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { db } from './db.js';

export type Role = 'admin' | 'editor' | 'viewer';

export interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(userId: number): string {
  return jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: '未登录或登录已过期' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret) as { sub: string };
    const user = db
      .prepare(`SELECT id, username, display_name, email, role, status FROM users WHERE id = ?`)
      .get(Number(payload.sub)) as (AuthUser & { status: string }) | undefined;
    if (!user || user.status !== 'active') {
      res.status(401).json({ error: '账号不存在或已被禁用' });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: '未登录或登录已过期' });
  }
}

/** 角色门槛:admin > editor > viewer */
const roleLevel: Record<Role, number> = { admin: 3, editor: 2, viewer: 1 };

export function requireRole(minRole: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || roleLevel[req.user.role] < roleLevel[minRole]) {
      res.status(403).json({ error: '权限不足' });
      return;
    }
    next();
  };
}

export function audit(req: Request, action: string, target = '', detail = ''): void {
  db.prepare(`INSERT INTO audit_logs (user_id, username, action, target, detail) VALUES (?, ?, ?, ?, ?)`).run(
    req.user?.id ?? null,
    req.user?.username ?? '',
    action,
    target,
    detail
  );
}
