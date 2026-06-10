/** AI 助手会话管理:基于 Pi SDK(pi.dev),每个后台用户一个独立会话 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { config } from '../config.js';
import { db } from '../db.js';
import type { AuthUser } from '../auth.js';
import { buildAssistantTools } from './tools.js';
import { getSettings } from '../settings.js';
import { getLocalBrowserPath, isSerpConfigured } from '../brightdata.js';
import { isQccConfigured } from '../qcc.js';

/** 独立的 agent 目录,避免加载用户机器上 ~/.pi 的全局扩展/技能 */
const AGENT_DIR = path.join(config.dataDir, 'pi-agent');
fs.mkdirSync(AGENT_DIR, { recursive: true });

export interface AssistantModelInfo {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * DeepSeek 官方旧模型名映射(api-docs.deepseek.com,旧名 2026/07/24 弃用):
 * deepseek-chat → deepseek-v4-flash 非思考模式;deepseek-reasoner → deepseek-v4-flash 思考模式。
 */
const DEEPSEEK_LEGACY_MODELS: Record<string, { id: string; thinking?: ThinkingLevel }> = {
  'deepseek-chat': { id: 'deepseek-v4-flash' },
  'deepseek-reasoner': { id: 'deepseek-v4-flash', thinking: 'high' },
};

interface AiRuntimeConfig {
  provider?: string;
  modelId?: string;
  thinking?: ThinkingLevel;
  apiKey?: string;
}

function getAiRuntimeConfig(): AiRuntimeConfig {
  const settings = getSettings();
  return {
    provider: settings.ai_provider || process.env.AI_PROVIDER,
    modelId: settings.ai_model || process.env.AI_MODEL,
    thinking: THINKING_LEVELS.includes(settings.ai_thinking as ThinkingLevel)
      ? (settings.ai_thinking as ThinkingLevel)
      : (process.env.AI_THINKING as ThinkingLevel | undefined),
    apiKey: settings.ai_api_key || undefined,
  };
}

async function resolveModel(authStorage: AuthStorage, modelRegistry: ModelRegistry, aiConfig: AiRuntimeConfig) {
  const provider = aiConfig.provider;
  let modelId = aiConfig.modelId;
  let defaultThinking: ThinkingLevel | undefined;

  if (aiConfig.apiKey && provider) {
    authStorage.setRuntimeApiKey(provider, aiConfig.apiKey);
  }

  if (modelId && (!provider || provider === 'deepseek')) {
    const legacy = DEEPSEEK_LEGACY_MODELS[modelId];
    if (legacy) {
      console.warn(`[assistant] DeepSeek 旧模型名 ${modelId} 将于 2026-07-24 弃用,已自动映射到 ${legacy.id}`);
      modelId = legacy.id;
      defaultThinking = legacy.thinking;
    }
  }

  if (provider && modelId) {
    const model = modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`未找到模型 ${provider}/${modelId},请检查 AI 提供商与模型 ID`);
    if (!modelRegistry.hasConfiguredAuth(model)) throw new Error(`已选择 ${provider}/${modelId},但该提供商未配置可用凭证`);
    return { model, defaultThinking };
  }

  const available = await modelRegistry.getAvailable();
  if (available.length === 0) {
    throw new Error(
      '未配置任何 AI 模型凭证。管理员可在后台「站点设置 → AI 助手」填写 API Key,也可以设置环境变量(如 DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY),' +
        '或先用 pi CLI 登录(凭证存于 ~/.pi/agent/auth.json),然后重启服务。' +
        '可选用 AI 提供商 + 模型 ID 指定模型。'
    );
  }

  if (provider) {
    const matches = available.filter((m) => m.provider === provider);
    const model = provider === 'deepseek' ? (matches.find((m) => m.id === 'deepseek-v4-flash') ?? matches[0]) : matches[0];
    if (!model) throw new Error(`已选择 ${provider},但该提供商未配置可用凭证`);
    return { model, defaultThinking };
  }

  // 只指定了 AI_MODEL:在可用提供商中找,官方 deepseek 优先
  if (modelId) {
    const matches = available.filter((m) => m.id === modelId);
    const model = matches.find((m) => m.provider === 'deepseek') ?? matches[0];
    if (!model) throw new Error(`已配置的提供商中没有模型 ${modelId},可补充 AI_PROVIDER 指定来源`);
    return { model, defaultThinking };
  }

  // 未指定模型:优先 DeepSeek 官方 API(api.deepseek.com),默认 V4 Flash(快、便宜、支持工具调用)
  const deepseek = available.filter((m) => m.provider === 'deepseek');
  const model = deepseek.find((m) => m.id === 'deepseek-v4-flash') ?? deepseek[0] ?? available[0]!;
  return { model, defaultThinking };
}

function buildSystemPrompt(user: AuthUser): string {
  const roleText = { admin: '管理员', editor: '编辑', viewer: '只读' }[user.role];
  const settings = Object.fromEntries(
    (db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]).map((r) => [r.key, r.value])
  );
  const today = new Date().toISOString().slice(0, 10);
  const browserPath = getLocalBrowserPath();
  const serpReady = isSerpConfigured();
  const qccReady = isQccConfigured();
  return `你是 BigCMS 企业内容管理系统的 AI 运营助手,通过提供给你的工具管理企业官网的全部信息。

今天是 ${today}。
站点名称:${settings.site_name || '(未设置)'};站点描述:${settings.site_description || '(未设置)'}。
用户要求改 wordmark、页眉品牌、首页文案、导航文字、页脚署名、企业叙事等时,用 update_settings 修改对应字段(如 site_name、site_description、home_value_1~3、home_about_title、home_about_text、hero_secondary_cta、cta_title、cta_text 等),不要只改文章。首页叙事字段留空时对应区块会自动隐藏(能力点、关于我们)。
当前操作者:${user.display_name || user.username}(角色:${roleText})。你的所有操作都会以该用户身份写入审计日志。

站点结构:
- 前台官网(/):企业首页 + 新闻中心 + 商品(/products,分类 slug=products) + 联系我们(/contact,用户可提交联系表单,提交即进入销售线索池)
- 已发布文章的前台地址为 /news/<slug>;新闻中心支持按分类(/news?category=<slug>)、标签(/news?tag=<slug>)和关键词(/news?q=)筛选;RSS 在 /feed.xml
- 管理后台(/admin):文章、分类、标签、媒体库、联系人、用户、站点设置、审计日志
- 「商品」是分类 slug=products;在该分类下发布文章即可展示在 /products

工作准则:
1. 用简体中文回复,简洁直接;操作完成后简要说明做了什么,并给出关键信息(如文章 ID、slug、前台链接)。
2. 写文章正文用 Markdown;创建文章默认存为草稿(draft),除非用户明确要求直接发布(published)。用户要求"明天早上发"之类的未来时间时,用 scheduled_at 设定时发布(结合上文的今天日期推算,注意带时区)。
3. 任何删除操作(文章/分类/标签/媒体/用户)以及批量修改(bulk_update_articles)前,必须先向用户列出将受影响的对象并得到明确确认,确认后才能执行。
4. 修改前先查:更新或删除之前,先用查询工具确认目标存在、拿到准确 ID,不要凭空猜测 ID。
5. 多篇文章做同样的状态/分类变更时,优先用 bulk_update_articles 一次完成,而不是逐篇调用 update_article。
6. 不确定用户意图时先提问澄清,不要擅自行动。
7. 权限受限时(工具不存在或报错「仅管理员」),如实告知用户当前角色无权限。
8. 涉及封面图时,可用 list_media 查看媒体库中已有的图片并使用其 url。
9. 外部数据工具(配置状态见下,未就绪时如实告知管理员,不要编造):
- web_search:Bright Data SERP API,${serpReady ? '已配置' : '未配置(需 API Key + SERP Zone)'}
- browse_webpage:服务器无头浏览器(Puppeteer),已就绪${browserPath ? `(自定义浏览器路径:${browserPath})` : '(使用内置 Chromium)'}
- search_companies:企查查 API 886,${qccReady ? '已配置' : '未配置(需 AppKey + SecretKey)'}
browse_webpage 只用本机浏览器打开 URL 提取正文,不走任何云浏览器服务。

销售线索追踪(联系表单提交 = 线索,你是销售运营助理):
- 线索生命周期固定为五个阶段,只能用这五个值:pending(待跟进)→ contacted(已联系)→ qualified(已确认意向)→ converted(已成交)/ lost(已流失)。阶段语义:contacted = 已完成首次触达;qualified = 对方确认了真实需求与购买意向;converted / lost 为终态,进入终态后不再安排回访。
- 工具:list_contacts(支持按 stage / source / overdue 筛选)、get_contact(详情 + 跟进时间线)、lead_stats(漏斗统计)、update_contact(改 status / stage / next_follow_up_at)、add_contact_note(追加跟进记录)、create_lead(录入主动开发的线索,source=ai)。线索来源分 form(前台表单)与 ai(主动开发)。
- 推进纪律:每次推进阶段时,同步做两件事——用 add_contact_note 写一条跟进记录说明依据(和谁沟通、客户说了什么、下一步行动),并用 next_follow_up_at 设定下次回访日期;没有依据不要擅自推进阶段,更不要跳过中间阶段(pending 直接到 converted 需要用户明确说明缘由)。
- 标记 lost 时,必须在跟进记录里写明流失原因(预算、时机、竞品、无回应等),这是后续复盘的数据基础。
- 用户问"今天该跟谁""有没有漏掉的客户"时:先查 overdue=true 的逾期线索,再查 stage=pending 的未触达线索,按提交时间从旧到新给出行动清单(姓名、公司、留言摘要、建议动作)。
- 用户要汇报/复盘时:用 lead_stats 给出漏斗(各阶段数量、逾期数),并主动指出瓶颈(如大量线索停在 pending 说明首次响应不及时)。
- 客户留言、电话、邮箱属于个人信息:仅在用户明确询问时引用必要字段,不要在汇总报告里成段罗列。
- 富线索背景调查:对方留了公司名时,可用 search_companies 查工商信息(规模、行业、风险),把要点写进跟进记录,帮助判断线索质量。

主动开发线索(用户要你"找客户/找线索"时,按此流程执行):
1. 先和用户对齐目标客户画像:行业、地区、规模、典型需求场景。画像不清楚就先问,不要凭空撒网。
2. 检索候选公司:用 search_companies(企查查)按行业/地区/关键词搜目标企业;用 web_search 找行业名录、展会参展商、招标公告、新闻报道中的活跃公司;必要时用 browse_webpage 读公司官网确认业务方向与联系方式。
3. 资格初筛:对照画像逐一判断,淘汰明显不符的(规模不符、业务无关、经营异常)。判断依据要具体,不要只说"看起来合适"。
4. 查重后入库:每家候选公司先用 list_contacts 按公司名/电话查重;不存在再用 create_lead 录入,message 写清三件事——公司是做什么的、为什么判断它是潜在客户、信息来源(哪条检索结果/哪个页面)。能找到的联系方式(官网电话、公开邮箱)一并填入。
5. 安排触达:为每条新线索用 next_follow_up_at 设定首次触达日期,数量多时分散到多天,避免堆积逾期。
6. 收尾汇报:列出本次新增线索清单(公司、判断依据、建议触达顺序)与放弃的候选及原因。一次批量开发建议控制在 10 家以内,宁缺毋滥。
7. 边界:外部工具未就绪时不要调用或不要编造结果;绝不虚构公司信息与联系方式。`;
}

interface Entry {
  session: AgentSession;
  model: AssistantModelInfo;
  /** 会话创建日(系统提示里写死了「今天是 X」,跨天后需用新提示重建) */
  day: string;
}

const sessions = new Map<number, Promise<Entry>>();

const todayStr = () => new Date().toISOString().slice(0, 10);

/** 每个用户独立的会话落盘目录(跨服务重启恢复对话) */
function userSessionDir(userId: number): string {
  return path.join(AGENT_DIR, 'sessions', `user-${userId}`);
}

/** open.fresh:新建空会话;open.path:打开指定会话文件;都不传:续用最近会话 */
interface OpenOptions {
  fresh?: boolean;
  path?: string;
}

async function createEntry(user: AuthUser, open?: OpenOptions): Promise<Entry> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const aiConfig = getAiRuntimeConfig();
  const { model, defaultThinking } = await resolveModel(authStorage, modelRegistry, aiConfig);
  const settingsManager = SettingsManager.inMemory({});
  const sessionDir = userSessionDir(user.id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd: AGENT_DIR,
    agentDir: AGENT_DIR,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: buildSystemPrompt(user),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: AGENT_DIR,
    agentDir: AGENT_DIR,
    model,
    thinkingLevel: aiConfig.thinking && THINKING_LEVELS.includes(aiConfig.thinking) ? aiConfig.thinking : (defaultThinking ?? 'off'),
    authStorage,
    modelRegistry,
    noTools: 'builtin',
    customTools: buildAssistantTools(user),
    resourceLoader: loader,
    // 续用该用户最近一次会话文件,没有则新建(落盘,跨重启恢复)
    sessionManager: open?.fresh
      ? SessionManager.create(AGENT_DIR, sessionDir)
      : open?.path
        ? SessionManager.open(open.path, sessionDir)
        : SessionManager.continueRecent(AGENT_DIR, sessionDir),
    settingsManager,
  });

  return {
    session,
    model: {
      provider: model.provider,
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? 0,
    },
    day: todayStr(),
  };
}

/**
 * 获取(或惰性创建)某用户的助手会话。
 * 跨天后会用最新系统提示重建会话(日期/站点设置/线索规则都在系统提示里),
 * 对话历史通过 SessionManager.continueRecent 从磁盘恢复,不会丢。
 */
export async function getAssistantEntry(user: AuthUser): Promise<Entry> {
  const pending = sessions.get(user.id);
  if (pending) {
    try {
      const entry = await pending;
      // 正在生成时不重建,避免打断进行中的回复
      if (entry.day === todayStr() || entry.session.isStreaming) return entry;
      sessions.delete(user.id);
      entry.session.dispose();
    } catch {
      sessions.delete(user.id);
    }
  }
  const fresh = createEntry(user);
  fresh.catch(() => sessions.delete(user.id));
  sessions.set(user.id, fresh);
  return fresh;
}

/** 重置某用户的会话(清空对话历史,含落盘文件) */
export async function resetAssistantSession(userId: number): Promise<void> {
  const pending = sessions.get(userId);
  sessions.delete(userId);
  if (pending) {
    try {
      const { session } = await pending;
      await session.abort();
      session.dispose();
    } catch {
      // 创建本来就失败了,无需清理
    }
  }
  try {
    fs.rmSync(userSessionDir(userId), { recursive: true, force: true });
  } catch {
    /* 目录不存在等情况忽略 */
  }
}

export interface AssistantSessionInfo {
  id: string;
  preview: string;
  messageCount: number;
  modified: string;
  current: boolean;
}

/** 列出某用户的全部历史会话(按最近修改倒序,过滤空会话) */
export async function listAssistantSessions(user: AuthUser): Promise<AssistantSessionInfo[]> {
  const list = await SessionManager.list(AGENT_DIR, userSessionDir(user.id));
  let currentId: string | undefined;
  const pending = sessions.get(user.id);
  if (pending) {
    try {
      currentId = (await pending).session.sessionManager.getSessionId();
    } catch {
      /* 创建失败则没有当前会话 */
    }
  }
  return list
    .filter((s) => s.messageCount > 0 || s.id === currentId)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .map((s) => ({
      id: s.id,
      preview: (s.firstMessage || '(新对话)').slice(0, 60),
      messageCount: s.messageCount,
      modified: s.modified.toISOString(),
      current: s.id === currentId,
    }));
}

async function disposeCurrent(userId: number): Promise<void> {
  const pending = sessions.get(userId);
  sessions.delete(userId);
  if (pending) {
    try {
      const { session } = await pending;
      if (session.isStreaming) await session.abort();
      session.dispose();
    } catch {
      /* 创建失败无需清理 */
    }
  }
}

/** 切换会话:fresh=true 新建,否则打开 sessionId 对应的会话文件 */
export async function switchAssistantSession(user: AuthUser, opts: { fresh?: boolean; sessionId?: string }): Promise<Entry> {
  let path: string | undefined;
  if (!opts.fresh) {
    const list = await SessionManager.list(AGENT_DIR, userSessionDir(user.id));
    path = list.find((s) => s.id === opts.sessionId)?.path;
    if (!path) throw new Error('会话不存在');
  }
  await disposeCurrent(user.id);
  const fresh = createEntry(user, { fresh: opts.fresh, path });
  fresh.catch(() => sessions.delete(user.id));
  sessions.set(user.id, fresh);
  return fresh;
}

/** 删除单个会话文件;若删的是当前会话,则下次访问自动续用最近的其他会话 */
export async function deleteAssistantSession(user: AuthUser, sessionId: string): Promise<void> {
  const list = await SessionManager.list(AGENT_DIR, userSessionDir(user.id));
  const target = list.find((s) => s.id === sessionId);
  if (!target) throw new Error('会话不存在');
  const pending = sessions.get(user.id);
  if (pending) {
    try {
      const entry = await pending;
      if (entry.session.sessionManager.getSessionId() === sessionId) await disposeCurrent(user.id);
    } catch {
      sessions.delete(user.id);
    }
  }
  fs.rmSync(target.path, { force: true });
}

/** 重置全部用户的 AI 会话。用于管理员更新模型或凭证后让配置立即生效。 */
export async function resetAssistantSessions(): Promise<void> {
  const userIds = [...sessions.keys()];
  await Promise.all(userIds.map((userId) => resetAssistantSession(userId)));
}
