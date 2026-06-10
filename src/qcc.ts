/** 企查查开放平台 API 886 — 企业模糊搜索 */
import crypto from 'node:crypto';
import { getSettings } from './settings.js';

const QCC_FUZZY_SEARCH_URL = 'https://api.qichacha.com/FuzzySearch/GetList';

export interface QccConfig {
  appKey?: string;
  secretKey?: string;
}

export interface QccCompanyRow {
  KeyNo?: string;
  Name?: string;
  CreditCode?: string;
  StartDate?: string;
  OperName?: string;
  Status?: string;
  No?: string;
  Address?: string;
}

export interface QccFuzzySearchResult {
  status: string;
  message: string;
  pageIndex: number;
  companies: QccCompanyRow[];
  raw?: unknown;
}

export function getQccConfig(): QccConfig {
  const s = getSettings();
  return {
    appKey: s.qcc_app_key?.trim(),
    secretKey: s.qcc_secret_key?.trim(),
  };
}

export function isQccConfigured(cfg: QccConfig = getQccConfig()): boolean {
  return Boolean(cfg.appKey && cfg.secretKey);
}

function buildAuthHeaders(appKey: string, secretKey: string): { Token: string; Timespan: string } {
  const timespan = Math.floor(Date.now() / 1000).toString();
  const token = crypto.createHash('md5').update(`${appKey}${timespan}${secretKey}`).digest('hex').toUpperCase();
  return { Token: token, Timespan: timespan };
}

export interface QccFuzzySearchOptions {
  searchKey: string;
  pageIndex?: number;
  pageSize?: number;
  provinceCode?: string;
  cityCode?: string;
}

/** 企查查 API 886:按关键词模糊搜索企业(每次最多返回若干条) */
export async function qccFuzzySearch(opts: QccFuzzySearchOptions): Promise<QccFuzzySearchResult> {
  const cfg = getQccConfig();
  if (!cfg.appKey || !cfg.secretKey) {
    throw new Error(
      '企查查 API 未配置。请在后台「站点设置 → 数据服务 → 企查查」填写 AppKey 与 SecretKey。'
    );
  }

  const searchKey = opts.searchKey.trim();
  if (!searchKey) throw new Error('请提供搜索关键词');

  const pageIndex = Math.max(1, opts.pageIndex ?? 1);
  const params = new URLSearchParams({
    key: cfg.appKey,
    searchKey,
    pageIndex: String(pageIndex),
  });
  if (opts.pageSize !== undefined) {
    const pageSize = Math.min(20, Math.max(1, opts.pageSize));
    params.set('pageSize', String(pageSize));
  }
  if (opts.provinceCode?.trim()) params.set('provinceCode', opts.provinceCode.trim());
  if (opts.cityCode?.trim()) params.set('cityCode', opts.cityCode.trim());

  const resp = await fetch(`${QCC_FUZZY_SEARCH_URL}?${params}`, {
    headers: buildAuthHeaders(cfg.appKey, cfg.secretKey),
  });

  const text = await resp.text();
  let data: { Status?: string; Message?: string; Result?: QccCompanyRow[] };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error(`企查查 API 响应无效: ${text.slice(0, 300)}`);
  }

  const status = String(data.Status ?? '');
  const message = String(data.Message ?? '');
  if (!resp.ok) {
    throw new Error(`企查查 API HTTP ${resp.status}: ${message || text.slice(0, 300)}`);
  }
  if (status !== '200') {
    throw new Error(`企查查 API 错误 ${status}: ${message || '请求失败'}`);
  }

  return {
    status,
    message,
    pageIndex,
    companies: Array.isArray(data.Result) ? data.Result : [],
    raw: data,
  };
}
