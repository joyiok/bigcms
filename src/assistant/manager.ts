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
import type { AuthUser } from '../auth.js';
import { buildAssistantTools } from './tools.js';

/** 独立的 agent 目录,避免加载用户机器上 ~/.pi 的全局扩展/技能 */
const AGENT_DIR = path.join(config.dataDir, 'pi-agent');
fs.mkdirSync(AGENT_DIR, { recursive: true });

/** 凭证仍走默认位置(~/.pi/agent/auth.json + 环境变量),与 pi CLI 共享 */
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

export interface AssistantModelInfo {
  provider: string;
  id: string;
  name: string;
}

async function resolveModel() {
  const provider = process.env.AI_PROVIDER;
  const modelId = process.env.AI_MODEL;
  if (provider && modelId) {
    const model = modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`未找到模型 ${provider}/${modelId},请检查 AI_PROVIDER / AI_MODEL 环境变量`);
    return model;
  }
  const available = await modelRegistry.getAvailable();
  if (available.length === 0) {
    throw new Error(
      '未配置任何 AI 模型凭证。请设置环境变量(如 ANTHROPIC_API_KEY / OPENAI_API_KEY),' +
        '或先用 pi CLI 登录(凭证存于 ~/.pi/agent/auth.json),然后重启服务。' +
        '可选用 AI_PROVIDER + AI_MODEL 指定模型。'
    );
  }
  return available[0]!;
}

function buildSystemPrompt(user: AuthUser): string {
  const roleText = { admin: '管理员', editor: '编辑', viewer: '只读' }[user.role];
  return `你是 BigCMS 企业内容管理系统的 AI 运营助手,通过提供给你的工具管理企业官网的全部信息。

当前操作者:${user.display_name || user.username}(角色:${roleText})。你的所有操作都会以该用户身份写入审计日志。

站点结构:
- 前台官网(/):企业首页 + 新闻中心,展示「已发布」状态的文章
- 管理后台(/admin):文章、分类、标签、媒体库、用户、站点设置、审计日志

工作准则:
1. 用简体中文回复,简洁直接;操作完成后简要说明做了什么,并给出关键信息(如文章 ID、slug)。
2. 写文章正文用 Markdown;创建文章默认存为草稿(draft),除非用户明确要求直接发布(published)。
3. 任何删除操作(文章/分类/标签/用户)以及批量修改前,必须先向用户复述将要执行的操作并得到明确确认,确认后才能调用删除工具。
4. 修改前先查:更新或删除之前,先用查询工具确认目标存在、拿到准确 ID,不要凭空猜测 ID。
5. 不确定用户意图时先提问澄清,不要擅自行动。
6. 权限受限时(工具不存在或报错「仅管理员」),如实告知用户当前角色无权限。
7. 涉及封面图时,可用 list_media 查看媒体库中已有的图片并使用其 url。`;
}

interface Entry {
  session: AgentSession;
  model: AssistantModelInfo;
}

const sessions = new Map<number, Promise<Entry>>();

async function createEntry(user: AuthUser): Promise<Entry> {
  const model = await resolveModel();
  const settingsManager = SettingsManager.inMemory({});
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
    thinkingLevel: 'off',
    authStorage,
    modelRegistry,
    noTools: 'builtin',
    customTools: buildAssistantTools(user),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(AGENT_DIR),
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

/** 重置某用户的会话(清空对话历史) */
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
}
