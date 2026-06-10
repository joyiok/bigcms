/** AI 助手接口:SSE 流式聊天(由 Pi SDK 驱动) */
import { Router } from 'express';
import { calculateContextTokens, getLastAssistantUsage } from '@earendil-works/pi-coding-agent';
import { requireAuth, requireRole } from '../auth.js';
import { db } from '../db.js';
import {
  deleteAssistantSession,
  getAssistantEntry,
  listAssistantSessions,
  renameAssistantSession,
  resetAssistantSession,
  switchAssistantSession,
} from '../assistant/manager.js';

export const assistantRouter = Router();

assistantRouter.use(requireAuth, requireRole('editor'));

/** 把工具调用参数压成一行简短摘要,供前端展示(如「更新文章 id: 3, status: published」) */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    let v: string;
    if (typeof value === 'string') v = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    else if (Array.isArray(value)) v = `[${value.length} 项]`;
    else v = String(value);
    parts.push(`${key}: ${v}`);
    if (parts.join(', ').length > 120) break;
  }
  return parts.join(', ').slice(0, 140);
}

/** 助手可用性与当前模型 */
assistantRouter.get('/status', async (req, res) => {
  try {
    const { session, model } = await getAssistantEntry(req.user!);
    res.json({ ready: true, model, streaming: session.isStreaming });
  } catch (err) {
    res.json({ ready: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** AI 用量统计:今日 / 本月 token 与成本 */
assistantRouter.get('/usage', (_req, res) => {
  const sum = (since: string) =>
    db
      .prepare(`SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS turns FROM ai_usage WHERE created_at >= ${since}`)
      .get() as { tokens: number; cost: number; turns: number };
  res.json({ today: sum(`date('now')`), month: sum(`date('now', 'start of month')`) });
});

/** 对话历史(供前端重新进入页面时恢复) */
assistantRouter.get('/history', async (req, res) => {
  try {
    const { session } = await getAssistantEntry(req.user!);
    const messages: { role: 'user' | 'assistant'; text: string; tools: { name: string; args: string }[] }[] = [];
    for (const m of session.messages) {
      if (m.role === 'user') {
        const text =
          typeof m.content === 'string'
            ? m.content
            : m.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map((c) => c.text)
                .join('');
        // 跳过工具结果等系统注入消息
        if (text) messages.push({ role: 'user', text, tools: [] });
      } else if (m.role === 'assistant') {
        const text = m.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('');
        const tools = m.content
          .filter((c) => c.type === 'toolCall')
          .map((c) => ({ name: c.name, args: summarizeArgs((c as { arguments?: unknown }).arguments) }));
        if (text || tools.length) messages.push({ role: 'assistant', text, tools });
      }
    }
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** 历史会话列表(像聊天软件的会话侧栏) */
assistantRouter.get('/sessions', async (req, res) => {
  try {
    res.json({ sessions: await listAssistantSessions(req.user!) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** 新建对话 */
assistantRouter.post('/sessions/new', async (req, res) => {
  try {
    await switchAssistantSession(req.user!, { fresh: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** 切换到某个历史会话 */
assistantRouter.post('/sessions/open', async (req, res) => {
  try {
    await switchAssistantSession(req.user!, { sessionId: String(req.body?.id ?? '') });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** 重命名某个历史会话 */
assistantRouter.post('/sessions/rename', async (req, res) => {
  try {
    await renameAssistantSession(req.user!, String(req.body?.id ?? ''), String(req.body?.name ?? ''));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** 删除某个历史会话 */
assistantRouter.delete('/sessions/:id', async (req, res) => {
  try {
    await deleteAssistantSession(req.user!, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** 清空会话 */
assistantRouter.post('/reset', async (req, res) => {
  await resetAssistantSession(req.user!.id);
  res.json({ ok: true });
});

/** 中止当前正在生成的回复 */
assistantRouter.post('/abort', async (req, res) => {
  try {
    const { session } = await getAssistantEntry(req.user!);
    if (session.isStreaming) await session.abort();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** 发送消息,SSE 流式返回 */
assistantRouter.post('/chat', async (req, res) => {
  const message = String(req.body?.message ?? '').trim();
  if (!message) {
    res.status(400).json({ error: '消息不能为空' });
    return;
  }

  let session;
  let model;
  try {
    ({ session, model } = await getAssistantEntry(req.user!));
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (session.isStreaming) {
    res.status(409).json({ error: 'AI 正在处理上一条消息,请稍候' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (type: string, payload: unknown) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  // 心跳:长工具调用期间无输出,防止代理/浏览器掐断空闲连接
  const heartbeat = setInterval(() => send('ping', {}), 15000);

  let finished = false;
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          send('delta', { text: event.assistantMessageEvent.delta });
        }
        break;
      case 'tool_execution_start':
        send('tool_start', { name: event.toolName, args: summarizeArgs(event.args) });
        break;
      case 'tool_execution_end':
        send('tool_end', { name: event.toolName, isError: event.isError });
        break;
      // 上下文接近窗口上限时 SDK 自动压缩(总结旧对话、保留近期),把过程透出给前端
      case 'compaction_start':
        send('compact_start', { reason: event.reason });
        break;
      case 'compaction_end':
        send('compact_end', { aborted: event.aborted, error: event.errorMessage || '' });
        break;
    }
  });

  // 客户端断开时不中止生成:让本轮完整生成并落盘,前端重连后从历史恢复全文。
  // (用户主动点「停止」走 /abort 接口)
  res.on('close', () => {
    if (!finished) {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });

  try {
    await session.prompt(message);
    const errorMessage = session.agent.state.errorMessage;
    if (errorMessage) send('error', { message: errorMessage });
    // 汇总本轮全部 assistant 消息的 token 用量与成本(一轮可能含多次工具往返)
    let tokens = 0;
    let cost = 0;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]!;
      if (m.role === 'user') break;
      if (m.role === 'assistant' && m.usage) {
        tokens += m.usage.totalTokens ?? 0;
        cost += m.usage.cost?.total ?? 0;
      }
    }
    // 记账:用量入库,供「本月 AI 花费」统计
    if (tokens) {
      db.prepare(`INSERT INTO ai_usage (user_id, tokens, cost) VALUES (?, ?, ?)`).run(req.user!.id, tokens, cost);
    }
    // 上下文水位:当前会话占模型窗口的比例,供前端展示
    let context = 0;
    try {
      const usage = getLastAssistantUsage(session.sessionManager.getEntries());
      if (usage) context = calculateContextTokens(usage);
    } catch {
      /* 估算失败不影响回复 */
    }
    send('done', {
      ...(tokens ? { tokens, cost } : {}),
      ...(context && model.contextWindow ? { context, window: model.contextWindow } : {}),
    });
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : String(err) });
    send('done', {});
  } finally {
    finished = true;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  }
});
