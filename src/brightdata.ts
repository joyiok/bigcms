/** Bright Data SERP API + 本地无头浏览器网页抓取 */
import fs from 'node:fs';
import { getSettings } from './settings.js';

const BRIGHTDATA_REQUEST_URL = 'https://api.brightdata.com/request';
const LOCAL_BROWSER_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

export type SerpEngine = 'google' | 'bing' | 'duckduckgo';
export type SerpDataFormat = 'parsed_light' | 'markdown' | 'json';

export interface BrightDataConfig {
  apiKey?: string;
  serpZone?: string;
}

export function getBrightDataConfig(): BrightDataConfig {
  const s = getSettings();
  return {
    apiKey: s.brightdata_api_key?.trim(),
    serpZone: s.brightdata_serp_zone?.trim(),
  };
}

export function isSerpConfigured(cfg: BrightDataConfig = getBrightDataConfig()): boolean {
  return Boolean(cfg.apiKey && cfg.serpZone);
}

/**
 * 自定义浏览器路径(后台「本地浏览器路径」或环境变量 BROWSER_EXECUTABLE / CHROME_PATH)。
 * 留空时使用 puppeteer 随 npm install 自带的 Chromium,无需配置。
 */
export function getLocalBrowserPath(): string | undefined {
  const fromSettings = getSettings().browser_executable_path?.trim();
  if (fromSettings) return fromSettings;
  const fromEnv = process.env.BROWSER_EXECUTABLE?.trim() || process.env.CHROME_PATH?.trim();
  return fromEnv || undefined;
}

/** puppeteer 自带浏览器,始终可用 */
export function isLocalBrowserConfigured(): boolean {
  return true;
}

/** @deprecated 使用 isLocalBrowserConfigured */
export function isBrowserConfigured(): boolean {
  return isLocalBrowserConfigured();
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
      'Bright Data SERP API 未配置。请在后台「站点设置 → Bright Data」填写 API Key 与 SERP Zone。'
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

function parseBrowseUrl(url: string): URL {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('仅支持 http/https URL');
  }
  return target;
}

function assertLocalBrowserExists(executablePath: string): void {
  try {
    fs.accessSync(executablePath, fs.constants.F_OK);
  } catch {
    throw new Error(`本地浏览器路径不存在: ${executablePath}`);
  }
}

async function scrapePage(
  openPage: () => Promise<{
    goto: (url: string, opts: { waitUntil: BrowsePageOptions['waitUntil'] }) => Promise<unknown>;
    evaluate: <T>(fn: () => T) => Promise<T>;
    setDefaultNavigationTimeout: (ms: number) => void;
  }>,
  target: URL,
  opts: BrowsePageOptions
): Promise<{ title: string; url: string; text: string }> {
  const page = await openPage();
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
}

/** 通过无头浏览器渲染并抓取页面正文(默认 puppeteer 自带 Chromium,可在后台配置自定义路径) */
export async function browsePage(opts: BrowsePageOptions): Promise<{ title: string; url: string; text: string }> {
  const target = parseBrowseUrl(opts.url);
  const executablePath = getLocalBrowserPath();
  if (executablePath) assertLocalBrowserExists(executablePath);
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: LOCAL_BROWSER_ARGS,
  });
  try {
    return await scrapePage(() => browser.newPage(), target, opts);
  } finally {
    await browser.close();
  }
}
