// SQLite 热备份:VACUUM INTO 生成一致性快照,服务运行中也可安全执行
// 用法:npm run backup(可用 DATA_DIR 指定数据目录,默认 ./data)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || './data';
const dbPath = path.join(DATA_DIR, 'bigcms.db');
if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在: ${dbPath}`);
  process.exit(1);
}

const backupDir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = path.join(backupDir, `bigcms-${stamp}.db`);

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
db.close();

const size = fs.statSync(outPath).size;
console.log(`备份完成: ${outPath} (${(size / 1024).toFixed(1)} KB)`);
console.log('提示:上传目录 uploads/ 不在数据库内,请一并备份。');
