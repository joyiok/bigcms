import { config } from './config.js';
import { seed } from './db.js';
import { startScheduler } from './scheduler.js';
import { createApp } from './app.js';

seed();
startScheduler();

createApp().listen(config.port, config.host, () => {
  const baseUrl = `http://${config.host}:${config.port}`;
  console.log(`BigCMS 已启动: ${baseUrl}`);
  console.log(`前台站点:     ${baseUrl}/`);
  console.log(`管理后台:     ${baseUrl}/admin/`);
});
