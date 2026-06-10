import express from 'express';
import path from 'node:path';
import { config, ROOT_DIR } from './config.js';
import { seed } from './db.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { articlesRouter } from './routes/articles.js';
import { categoriesRouter, tagsRouter } from './routes/taxonomy.js';
import { mediaRouter } from './routes/media.js';
import { auditRouter, dashboardRouter, publicRouter, settingsRouter } from './routes/misc.js';
import { assistantRouter } from './routes/assistant.js';
import { siteRouter } from './routes/site.js';

seed();

const app = express();
app.disable('x-powered-by');
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
app.use('/api/assistant', assistantRouter);
app.use('/api/public', publicRouter);

app.use('/uploads', express.static(config.uploadDir));
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

app.listen(config.port, () => {
  console.log(`BigCMS 已启动: http://localhost:${config.port}`);
  console.log(`前台站点:     http://localhost:${config.port}/`);
  console.log(`管理后台:     http://localhost:${config.port}/admin/`);
});
