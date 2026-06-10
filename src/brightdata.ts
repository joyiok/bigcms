/** Bright Data SERP API + Scraping Browser 集成 */
import { getSettings } from './settings.js';

const BRIGHTDATA_REQUEST_URL = 'https://api.brightdata.com/request';
const BROWSER_CDP_HOST = 'brd.superproxy.io:9222';

export type SerpEngine = 'google' | 'bing' | 'duckduckgo';
export type SerpDataFormat = 'parsed_light' | 'markdown' | 'json';

export interface BrightDataConfig {
  apiKey?: string;
  serpZone?: string;
  browserAuth?: string;
}

export function getBrightDataConfig(): BrightDataConfig {
  const s = getSettings();
  const apiKey = s.brightdata_api_key?.trim() || process.env.BRIGHTDATA_API_KEY?.trim();
  const serpZone = s.brightdata_serp_zone?.trim() || process.env.BRIGHTDATA_SERP_ZONE?.trim();

  let browserAuth = process.env.BRIGHTDATA_BROWSER_AUTH?.trim();
  if (!browserAuth) {
    const customerId = s.brightdata_customer_id?.trim() || process.env.BRIGHTDATA_CUSTOMER_ID?.trim();
    const browserZone = s.brightdata_browser_zone?.trim() || process.env.BRIGHTDATA_BROWSER_ZONE?.trim();
    const browserPassword = s.brightdata_browser_password?.trim() || process.env.BRIGHTDATA_BROWSER_PASSWORD?.trim();
    if (customerId && browserZone && browserPassword) {
      browserAuth = `brd-customer-${customerId}-zone-${browserZone}:${browserPassword}`;
    }
  }

  return { apiKey, serpZone, browserAuth };
}

export function isSerpConfigured(cfg: BrightDataConfig = getBrightDataConfig()): boolean {
  return Boolean(cfg.apiKey && cfg.serpZone);
}

export function isBrowserConfigured(cfg: BrightDataConfig = getBrightDataConfig()): boolean {
  return Boolean(cfg.browserAuth);
}

function encodeAuthForWss(auth: string): string {
  const idx = auth.indexOf(':');
  if (idx < 0) return encodeURIComponent(auth);
  const user = auth.slice(0, idx);
  const pass = auth.slice(idx + 1);
  return `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
}

function buildSearchUrl(engine: SerpEngine, query: string, hl: string, gl: string, json = false): string {
  const q = encodeURIComponent(query);
  let url: string;
  if (engine === 'bing') {
    url = `https://www.bing.com/search?q=${q}&setlang=${encodeURIComponent(hl)}`;
  } else if (engine === 'duckduckgo') {
    url = `https://duckduckgo.com/?q=${q}`;
  } else {
    url = `https://www.google.com/search?q=${q}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`;
  }
  if (json) url += url.includes('?') ? '&brd_json=1' : '?brd_json=1';
  return url;
}

export interface SerpSearchOptions {
  query: string;
  engine?: SerpEngine;
  hl?: string;
  gl?: string;
  dataFormat?: SerpDataFormat;
}

/** 通过 Bright Data SERP API 获取结构化搜索结果 */
export async function serpSearch(opts: SerpSearchOptions): Promise<unknown> {
  const cfg = getBrightDataConfig();
  if (!cfg.apiKey || !cfg.serpZone) {
    throw new Error(
      'Bright Data SERP API 未配置。请在后台「站点设置 → Bright Data」填写 API Key 与 SERP Zone，或设置环境变量 BRIGHTDATA_API_KEY / BRIGHTDATA_SERP_ZONE。'
    );
  }

  const engine = opts.engine ?? 'google';
  const hl = opts.hl ?? 'zh-CN';
  const gl = opts.gl ?? 'cn';
  const dataFormat = opts.dataFormat ?? 'parsed_light';
  const useJson = dataFormat === 'json';

  const payload: Record<string, string> = {
    zone: cfg.serpZone,
    url: buildSearchUrl(engine, opts.query.trim(), hl, gl, useJson),
    format: 'raw',
  };
  if (dataFormat === 'parsed_light') payload.data_format = 'parsed_light';
  if (dataFormat === 'markdown') payload.data_format = 'markdown';

  const resp = await fetch(BRIGHTDATA_REQUEST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`SERP API 错误 ${resp.status}: ${text.slice(0, 500)}`);
  }

  if (dataFormat === 'parsed_light' || dataFormat === 'json') {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text };
    }
  }
  return { markdown: text };
}

export interface BrowsePageOptions {
  url: string;
  maxChars?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
}

/** 通过 Bright Data Scraping Browser 渲染并抓取页面正文 */
export async function browsePage(opts: BrowsePageOptions): Promise<{ title: string; url: string; text: string }> {
  const cfg = getBrightDataConfig();
  if (!cfg.browserAuth) {
    throw new Error(
      'Bright Data Scraping Browser 未配置。请在后台填写 Account ID、Browser Zone、Browser 密码，或设置环境变量 BRIGHTDATA_BROWSER_AUTH(格式 user:pass)。'
    );
  }

  let target: URL;
  try {
    target = new URL(opts.url);
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('仅支持 http/https URL');
  }

  const { default: puppeteer } = await import('puppeteer-core');
  const endpoint = `wss://${encodeAuthForWss(cfg.browserAuth)}@${BROWSER_CDP_HOST}`;
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(120_000);
    await page.goto(target.href, { waitUntil: opts.waitUntil ?? 'domcontentloaded' });
    const meta = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
    }));
    let text = await page.evaluate(() => document.body?.innerText ?? '');
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    const maxChars = opts.maxChars ?? 12_000;
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(已截断)`;
    return { title: meta.title, url: meta.url, text };
  } finally {
    await browser.close();
  }
}
