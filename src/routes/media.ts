import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { audit, requireAuth, requireRole } from '../auth.js';

export const mediaRouter = Router();

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'application/zip',
  'video/mp4', 'audio/mpeg',
]);

const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadSize },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_TYPES.has(file.mimetype));
  },
});

mediaRouter.use(requireAuth);

mediaRouter.get('/', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 24));
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM media`).get() as { c: number }).c;
  const items = db
    .prepare(
      `SELECT m.*, u.display_name AS uploader_name FROM media m
       LEFT JOIN users u ON u.id = m.uploader_id
       ORDER BY m.id DESC LIMIT ? OFFSET ?`
    )
    .all(pageSize, (page - 1) * pageSize)
    .map((m) => ({ ...(m as Record<string, unknown>), url: `/uploads/${(m as { filename: string }).filename}` }));
  res.json({ items, total, page, page_size: pageSize });
});

mediaRouter.post('/', requireRole('editor'), upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: '未收到文件或文件类型不允许' });
    return;
  }
  // multer 以 latin1 解码文件名,转回 UTF-8 以正确保存中文名
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const id = db
    .prepare(`INSERT INTO media (filename, original_name, mime_type, size, uploader_id) VALUES (?, ?, ?, ?, ?)`)
    .run(req.file.filename, originalName, req.file.mimetype, req.file.size, req.user!.id).lastInsertRowid;
  audit(req, 'upload_media', `media:${id}`, originalName);
  const row = db.prepare(`SELECT * FROM media WHERE id = ?`).get(id) as { filename: string };
  res.status(201).json({ ...row, url: `/uploads/${row.filename}` });
});

mediaRouter.delete('/:id', requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT filename FROM media WHERE id = ?`).get(id) as { filename: string } | undefined;
  if (!row) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  db.prepare(`DELETE FROM media WHERE id = ?`).run(id);
  fs.rm(path.join(config.uploadDir, row.filename), { force: true }, () => {});
  audit(req, 'delete_media', `media:${id}`, row.filename);
  res.json({ ok: true });
});
