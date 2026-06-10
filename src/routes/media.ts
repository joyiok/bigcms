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

/** sharp 为可选依赖:加载失败(平台不支持等)时缩略图功能静默降级 */
let sharpModule: typeof import('sharp') | null | undefined;
async function getSharp() {
  if (sharpModule === undefined) {
    try {
      sharpModule = (await import('sharp')).default;
    } catch {
      sharpModule = null;
      console.warn('[media] sharp 不可用,跳过缩略图生成');
    }
  }
  return sharpModule;
}

/** 可生成缩略图的类型(gif 跳过以保留动画,svg 本身就是矢量) */
const THUMB_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const THUMB_WIDTH = 640;

function withUrls(m: Record<string, unknown>) {
  return {
    ...m,
    url: `/uploads/${m.filename as string}`,
    thumb_url: m.thumb_filename ? `/uploads/${m.thumb_filename as string}` : null,
  };
}

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
    .map((m) => withUrls(m as Record<string, unknown>));
  res.json({ items, total, page, page_size: pageSize });
});

mediaRouter.post('/', requireRole('editor'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: '未收到文件或文件类型不允许' });
    return;
  }
  // multer 以 latin1 解码文件名,转回 UTF-8 以正确保存中文名
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

  let thumbFilename: string | null = null;
  if (THUMB_TYPES.has(req.file.mimetype)) {
    const sharp = await getSharp();
    if (sharp) {
      try {
        const candidate = `${req.file.filename}.thumb.webp`;
        await sharp(path.join(config.uploadDir, req.file.filename))
          .rotate()
          .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(path.join(config.uploadDir, candidate));
        thumbFilename = candidate;
      } catch {
        /* 损坏图片等情况:无缩略图不影响上传 */
      }
    }
  }

  const id = db
    .prepare(`INSERT INTO media (filename, original_name, mime_type, size, thumb_filename, uploader_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.file.filename, originalName, req.file.mimetype, req.file.size, thumbFilename, req.user!.id).lastInsertRowid;
  audit(req, 'upload_media', `media:${id}`, originalName);
  const row = db.prepare(`SELECT * FROM media WHERE id = ?`).get(id) as Record<string, unknown>;
  res.status(201).json(withUrls(row));
});

mediaRouter.delete('/:id', requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT filename, thumb_filename FROM media WHERE id = ?`).get(id) as
    | { filename: string; thumb_filename: string | null }
    | undefined;
  if (!row) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  db.prepare(`DELETE FROM media WHERE id = ?`).run(id);
  fs.rm(path.join(config.uploadDir, row.filename), { force: true }, () => {});
  if (row.thumb_filename) fs.rm(path.join(config.uploadDir, row.thumb_filename), { force: true }, () => {});
  audit(req, 'delete_media', `media:${id}`, row.filename);
  res.json({ ok: true });
});
