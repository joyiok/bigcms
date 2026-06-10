import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  jwtSecret: process.env.JWT_SECRET ?? 'bigcms-dev-secret-change-me-in-production',
  jwtExpiresIn: '7d',
  dataDir: process.env.DATA_DIR ?? path.join(ROOT_DIR, 'data'),
  uploadDir: process.env.UPLOAD_DIR ?? path.join(ROOT_DIR, 'uploads'),
  maxUploadSize: 20 * 1024 * 1024, // 20MB
} as const;
