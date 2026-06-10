/** AI 助手接口:SSE 流式聊天(由 Pi SDK 驱动) */
import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { getAssistantEntry, resetAssistantSession } from '../assistant/manager.js';

export const assistantRouter = Router();

assistantRouter.use(requireAuth, requireRole('editor'));

/** 助手可用性与当前模型 */
assistantRouter.get('/status', async (req, res) => {
  try {
    const { model } = await getAssistantEntry(req.user!);
    res.json({ ready: true, model });
  } catch (err) {
    res.json({ ready: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** 对话历史(供前端重新进入页面时恢复) */
assistantRouter.get('/history', async (req, res) => {
  try {
    const { session } = await getAssistantEntry(req.user!);
    const messages: { role: 'user' | 'assistant'; text: string; tools: string[] }[] = [];
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
        const tools = m.content.filter((c) => c.type === 'toolCall').map((c) => c.name);
        if (text || tools.length) messages.push({ role: 'assistant', text, tools });
      }
    }
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** 清空会话 */
assistantRouter.post('/reset', async (req, res) => {
  await resetAssistantSession(req.user!.id);
  res.json({ ok: true });
});

/** 发送消息,SSE 流式返回 */
assistantRouter.post('/chat', async (req, res) => {
  const message = String(req.body?.message ?? '').trim();
  if (!message) {
    res.status(400).json({ error: '消息不能为空' });
    return;
  }

  let session;
  try {
    ({ session } = await getAssistantEntry(req.user!));
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

  let finished = false;
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          send('delta', { text: event.assistantMessageEvent.delta });
        }
        break;
      case 'tool_execution_start':
        send('tool_start', { name: event.toolName });
        break;
      case 'tool_execution_end':
        send('tool_end', { name: event.toolName, isError: event.isError });
        break;
    }
  });

  // 客户端断开时中止生成,避免空烧 token
  res.on('close', () => {
    if (!finished) void session.abort();
  });

  try {
    await session.prompt(message);
    const errorMessage = session.agent.state.errorMessage;
    if (errorMessage) send('error', { message: errorMessage });
    send('done', {});
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : String(err) });
    send('done', {});
  } finally {
    finished = true;
    unsubscribe();
    res.end();
  }
});
