import { config } from './config.js';
import { seed } from './db.js';
import { startScheduler } from './scheduler.js';
import { createApp } from './app.js';

seed();
startScheduler();

createApp().listen(config.port, () => {
  console.log(`BigCMS 已启动: http://localhost:${config.port}`);
  console.log(`前台站点:     http://localhost:${config.port}/`);
  console.log(`管理后台:     http://localhost:${config.port}/admin/`);
});
