/**
 * 共享无头浏览器(Puppeteer):供 AI 助手做交互式浏览。
 * - 多标签页:tab_id 引用,跨工具调用保持页面状态
 * - Cookie/Session:userDataDir 落盘 data/browser-profile,跨重启保持登录态
 * - 请求拦截:可按标签页屏蔽图片/媒体/字体以提速省流量
 */
import path from 'node:path';
import crypto from 'node:crypto';
import type { Browser, Page, CookieParam, CookieData } from 'puppeteer';
import { config } from './config.js';
import { getLocalBrowserPath } from './brightdata.js';

const PROFILE_DIR = path.join(config.dataDir, 'browser-profile');
const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
const MAX_TABS = 5;
const TAB_IDLE_MS = 10 * 60 * 1000;
const TEXT_MAX_CHARS = 8_000;

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.connected) return b;
    } catch {
      /* 上次启动失败,重试 */
    }
    browserPromise = null;
    tabs.clear();
  }
  browserPromise = (async () => {
    const { default: puppeteer } = await import('puppeteer');
    const executablePath = getLocalBrowserPath();
    return puppeteer.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: LAUNCH_ARGS,
      userDataDir: PROFILE_DIR,
    });
  })();
  return browserPromise;
}

interface Tab {
  page: Page;
  lastUsed: number;
  blockResources: boolean;
  /** 标签页归属用户:各用户的标签页相互隔离,避免并发互相干扰 */
  owner: number;
}

const tabs = new Map<string, Tab>();

// 空闲标签页定时回收,防止长期占内存
setInterval(() => {
  const now = Date.now();
  for (const [id, tab] of tabs) {
    if (now - tab.lastUsed > TAB_IDLE_MS) {
      tabs.delete(id);
      tab.page.close().catch(() => {});
    }
  }
}, 60_000).unref();

export function assertWebUrl(url: string): URL {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('仅支持 http/https URL');
  return target;
}

function getTab(tabId: string, owner: number): Tab {
  const tab = tabs.get(tabId);
  if (tab && tab.owner !== owner) throw new Error(`标签页 ${tabId} 不存在或已关闭(可用 browser_tabs 查看,或用 browser_open 新开)`);
  if (!tab || tab.page.isClosed()) {
    tabs.delete(tabId);
    throw new Error(`标签页 ${tabId} 不存在或已关闭(可用 browser_tabs 查看,或用 browser_open 新开)`);
  }
  tab.lastUsed = Date.now();
  return tab;
}

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

async function applyBlocking(page: Page, block: boolean): Promise<void> {
  await page.setRequestInterception(block);
  page.removeAllListeners('request');
  if (block) {
    page.on('request', (req) => {
      if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) void req.abort();
      else void req.continue();
    });
  }
}

export interface PageState {
  tab_id: string;
  title: string;
  url: string;
  text: string;
}

async function pageState(tabId: string, page: Page): Promise<PageState> {
  const title = await page.title().catch(() => '');
  let text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > TEXT_MAX_CHARS) text = `${text.slice(0, TEXT_MAX_CHARS)}\n…(已截断)`;
  return { tab_id: tabId, title, url: page.url(), text };
}

/** 打开 URL:新开标签页或复用已有标签页导航 */
export async function openTab(opts: { url: string; tabId?: string; blockResources?: boolean; owner: number }): Promise<PageState> {
  const target = assertWebUrl(opts.url);
  let id: string;
  let tab: Tab;
  if (opts.tabId) {
    id = opts.tabId;
    tab = getTab(id, opts.owner);
    if (opts.blockResources !== undefined && opts.blockResources !== tab.blockResources) {
      tab.blockResources = opts.blockResources;
      await applyBlocking(tab.page, tab.blockResources);
    }
  } else {
    const owned = [...tabs.values()].filter((t) => t.owner === opts.owner).length;
    if (owned >= MAX_TABS) throw new Error(`标签页已达上限 ${MAX_TABS} 个,请先用 browser_tabs 关闭不用的`);
    const browser = await getBrowser();
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(120_000);
    id = crypto.randomBytes(4).toString('hex');
    tab = { page, lastUsed: Date.now(), blockResources: Boolean(opts.blockResources), owner: opts.owner };
    if (tab.blockResources) await applyBlocking(page, true);
    tabs.set(id, tab);
  }
  await tab.page.goto(target.href, { waitUntil: 'domcontentloaded' });
  return pageState(id, tab.page);
}

export type BrowserAction =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; text: string }
  | { type: 'select'; selector: string; value: string }
  | { type: 'press'; key: string }
  | { type: 'wait'; ms: number }
  | { type: 'wait_for'; selector: string };

/** 在标签页上按顺序执行交互动作(点击/填表单/按键/等待),返回最终页面状态 */
export async function interact(owner: number, tabId: string, actions: BrowserAction[]): Promise<PageState> {
  const tab = getTab(tabId, owner);
  const page = tab.page;
  for (const [i, a] of actions.entries()) {
    try {
      if (a.type === 'click') {
        await page.waitForSelector(a.selector, { timeout: 15_000 });
        // 点击可能触发导航,二者竞速即可
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {}),
          page.click(a.selector),
        ]);
      } else if (a.type === 'fill') {
        await page.waitForSelector(a.selector, { timeout: 15_000 });
        await page.$eval(a.selector, (el) => {
          (el as HTMLInputElement).value = '';
        });
        await page.type(a.selector, a.text);
      } else if (a.type === 'select') {
        await page.select(a.selector, a.value);
      } else if (a.type === 'press') {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {}),
          page.keyboard.press(a.key as Parameters<typeof page.keyboard.press>[0]),
        ]);
      } else if (a.type === 'wait') {
        await new Promise((r) => setTimeout(r, Math.min(a.ms, 30_000)));
      } else if (a.type === 'wait_for') {
        await page.waitForSelector(a.selector, { timeout: 30_000 });
      }
    } catch (err) {
      throw new Error(`第 ${i + 1} 个动作(${a.type})失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return pageState(tabId, page);
}

/** 在标签页上执行自定义 JS,返回 JSON 可序列化的结果 */
export async function evaluateScript(owner: number, tabId: string, script: string): Promise<unknown> {
  const tab = getTab(tabId, owner);
  const result = await tab.page.evaluate(`(async () => { ${script} })()`);
  // 防止超大返回撑爆上下文
  const json = JSON.stringify(result ?? null);
  if (json && json.length > 50_000) throw new Error('脚本返回结果过大(>50KB),请在脚本里裁剪后再返回');
  return result ?? null;
}

/** 截图(指定标签页,或一次性打开 url 截完即关) */
export async function screenshot(opts: { tabId?: string; url?: string; fullPage?: boolean; owner: number }): Promise<Buffer> {
  const run = (page: Page) => page.screenshot({ type: 'png', fullPage: Boolean(opts.fullPage) });
  if (opts.tabId) return Buffer.from(await run(getTab(opts.tabId, opts.owner).page));
  if (!opts.url) throw new Error('需提供 tab_id 或 url');
  const target = assertWebUrl(opts.url);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    page.setDefaultNavigationTimeout(120_000);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(target.href, { waitUntil: 'networkidle2' });
    return Buffer.from(await run(page));
  } finally {
    await page.close().catch(() => {});
  }
}

/** 导出页面为 PDF */
export async function pagePdf(opts: { tabId?: string; url?: string; owner: number }): Promise<Buffer> {
  const run = (page: Page) => page.pdf({ format: 'A4', printBackground: true });
  if (opts.tabId) return Buffer.from(await run(getTab(opts.tabId, opts.owner).page));
  if (!opts.url) throw new Error('需提供 tab_id 或 url');
  const target = assertWebUrl(opts.url);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    page.setDefaultNavigationTimeout(120_000);
    await page.goto(target.href, { waitUntil: 'networkidle2' });
    return Buffer.from(await run(page));
  } finally {
    await page.close().catch(() => {});
  }
}

export async function listTabs(owner: number): Promise<{ tab_id: string; title: string; url: string }[]> {
  const out: { tab_id: string; title: string; url: string }[] = [];
  for (const [id, tab] of tabs) {
    if (tab.owner !== owner) continue;
    if (tab.page.isClosed()) {
      tabs.delete(id);
      continue;
    }
    out.push({ tab_id: id, title: await tab.page.title().catch(() => ''), url: tab.page.url() });
  }
  return out;
}

export async function closeTab(owner: number, tabId: string): Promise<void> {
  const tab = getTab(tabId, owner);
  tabs.delete(tabId);
  await tab.page.close().catch(() => {});
}

export interface CookieInput {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

/** Cookie 管理:get 读取当前标签页站点的 cookie;set 写入;clear 清空整个浏览器档案的 cookie */
export async function manageCookies(
  action: 'get' | 'set' | 'clear',
  opts: { tabId?: string; cookies?: CookieInput[]; owner: number }
): Promise<unknown> {
  const browser = await getBrowser();
  if (action === 'get') {
    if (!opts.tabId) throw new Error('get 需提供 tab_id');
    const cookies = await getTab(opts.tabId, opts.owner).page.cookies();
    return cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires }));
  }
  if (action === 'set') {
    if (!opts.cookies?.length) throw new Error('set 需提供 cookies 数组');
    if (opts.tabId) {
      await getTab(opts.tabId, opts.owner).page.setCookie(...(opts.cookies as CookieParam[]));
    } else {
      for (const c of opts.cookies) {
        if (!c.domain) throw new Error('不带 tab_id 的 set 需为每个 cookie 提供 domain');
      }
      await browser.setCookie(...(opts.cookies as CookieData[]));
    }
    return { ok: true, count: opts.cookies.length };
  }
  // clear:清掉整个持久化档案里的 cookie(退出所有登录态)
  const all = await browser.cookies();
  if (all.length) await browser.deleteCookie(...all);
  return { ok: true, cleared: all.length };
}
