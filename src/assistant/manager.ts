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

/** 独立的 agent 目录,避免加载用户机器上 ~/.pi 的全局扩展/技能 */
const AGENT_DIR = path.join(config.dataDir, 'pi-agent');
fs.mkdirSync(AGENT_DIR, { recursive: true });

export interface AssistantModelInfo {
  provider: string;
  id: string;
  name: string;
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
  return `你是 BigCMS 企业内容管理系统的 AI 运营助手,通过提供给你的工具管理企业官网的全部信息。

今天是 ${today}。
站点名称:${settings.site_name || '(未设置)'};站点描述:${settings.site_description || '(未设置)'}。
用户要求改 wordmark、页眉品牌、首页文案、导航文字、页脚署名等时,用 update_settings 修改对应字段(如 site_name、nav_home、site_footer_credit、hero_cta 等),不要只改文章。
当前操作者:${user.display_name || user.username}(角色:${roleText})。你的所有操作都会以该用户身份写入审计日志。

站点结构:
- 前台官网(/):企业首页 + 新闻中心 + 商品(/products,分类 slug=products) + 联系我们(/contact,用户可提交联系表单)
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
8. 涉及封面图时,可用 list_media 查看媒体库中已有的图片并使用其 url。`;
}

interface Entry {
  session: AgentSession;
  model: AssistantModelInfo;
}

const sessions = new Map<number, Promise<Entry>>();

/** 每个用户独立的会话落盘目录(跨服务重启恢复对话) */
function userSessionDir(userId: number): string {
  return path.join(AGENT_DIR, 'sessions', `user-${userId}`);
}

async function createEntry(user: AuthUser): Promise<Entry> {
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
    sessionManager: SessionManager.continueRecent(AGENT_DIR, sessionDir),
    settingsManager,
  });

  return {
    session,
    model: { provider: model.provider, id: model.id, name: model.name ?? model.id },
  };
}

/** 获取(或惰性创建)某用户的助手会话 */
export function getAssistantEntry(user: AuthUser): Promise<Entry> {
  let entry = sessions.get(user.id);
  if (!entry) {
    entry = createEntry(user);
    // 创建失败时移除缓存,下次重试
    entry.catch(() => sessions.delete(user.id));
    sessions.set(user.id, entry);
  }
  return entry;
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

/** 重置全部用户的 AI 会话。用于管理员更新模型或凭证后让配置立即生效。 */
export async function resetAssistantSessions(): Promise<void> {
  const userIds = [...sessions.keys()];
  await Promise.all(userIds.map((userId) => resetAssistantSession(userId)));
}
