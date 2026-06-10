/** Express 应用装配(不含监听与定时任务,便于集成测试直接挂载) */
import express from 'express';
import path from 'node:path';
import { config, ROOT_DIR } from './config.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { articlesRouter } from './routes/articles.js';
import { categoriesRouter, tagsRouter } from './routes/taxonomy.js';
import { mediaRouter } from './routes/media.js';
import { auditRouter, dashboardRouter, publicRouter, settingsRouter } from './routes/misc.js';
import { contactsRouter } from './routes/contacts.js';
import { assistantRouter } from './routes/assistant.js';
import { siteRouter } from './routes/site.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // 安全响应头(/uploads 在下方单独覆盖 CSP)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self'"
    );
    next();
  });

  app.use(express.json({ limit: '5mb' }));

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/articles', articlesRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/tags', tagsRouter);
  app.use('/api/media', mediaRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/audit-logs', auditRouter);
  app.use('/api/contacts', contactsRouter);
  app.use('/api/assistant', assistantRouter);
  app.use('/api/public', publicRouter);

  // 上传文件以沙箱模式伺服:直接打开 SVG 等文件时禁止执行脚本(防存储型 XSS)
  app.use(
    '/uploads',
    (_req, res, next) => {
      res.setHeader('Content-Security-Policy', 'sandbox');
      next();
    },
    express.static(config.uploadDir)
  );
  app.use(express.static(path.join(ROOT_DIR, 'public')));
  app.use(siteRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  app.use(((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: '请求体过大' });
      return;
    }
    if (err?.name === 'MulterError') {
      res.status(400).json({ error: `上传失败:${err.message}` });
      return;
    }
    console.error(err);
    res.status(500).json({ error: '服务器内部错误' });
  }) as express.ErrorRequestHandler);

  return app;
}
