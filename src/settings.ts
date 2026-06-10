import { db } from './db.js';

export const SECRET_SETTING_KEYS = new Set(['ai_api_key', 'brightdata_api_key', 'brightdata_browser_password']);

export function getSettings(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function getSafeSettings(includeSecretMeta = false): Record<string, string> {
  const settings = getSettings();
  const safe = Object.fromEntries(Object.entries(settings).filter(([key]) => !SECRET_SETTING_KEYS.has(key)));
  if (includeSecretMeta) {
    safe.ai_api_key_set = settings.ai_api_key ? '1' : '';
    safe.brightdata_api_key_set = settings.brightdata_api_key ? '1' : '';
    safe.brightdata_browser_password_set = settings.brightdata_browser_password ? '1' : '';
  }
  return safe;
}
