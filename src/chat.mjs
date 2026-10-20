// AI 对话模块：RAG 股票动态上下文注入、严格数据约束、分步支持同步响应与 SSE 流式输出
import { getLlmProfile } from './llm.mjs';
import { formatMoney } from './classify.mjs';

/**
 * 组装对话的动态上下文 (Context Injection)
 */
export function buildConversationContext(repo, stockCode) {
  if (!stockCode) {
    return {
      contextPrompt: '当前为全局宏观研判会话，未绑定特定个股。',
      refs: { stockCode: null, eventIds: [], quoteId: null },
    };
  }

  const stock = repo.getStock(stockCode);
  if (!stock) {
    return {
      contextPrompt: `绑定标的 ${stockCode} 不存在。`,
      refs: { stockCode, eventIds: [], quoteId: null },
    };
  }

  // 1. 最新行情
  const latestQuote = repo.getLatestQuote(stockCode);
  // 2. 近 5 日资金流
  const fundFlows = repo.getFundFlowsByRange(stockCode, null, null, 5);
  // 3. 近 7 天重大事件
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
  const events = repo.getEvents({ code: stockCode, fromDate: sevenDaysAgo, limit: 30 });
  // 4. 最近 20 条公告
  const anns = repo.getAnnouncements(stockCode, 20);

  const lines = [];
  lines.push(`【监控标的信息】${stock.name} (${stock.code}, ${stock.market.toUpperCase()}) 备注: ${stock.notes || '无'}`);

  if (latestQuote) {
    lines.push(`【最新行情快照】时间: ${latestQuote.trade_time}，现价: ${latestQuote.price}元，涨跌幅: ${latestQuote.change_pct}%，成交额: ${latestQuote.amount_wan}万元，量比: ${latestQuote.volume_ratio || '正常'}，换手率: ${latestQuote.turnover_rate}%`);
  } else {
    lines.push('【最新行情快照】暂无行情数据');
  }

  if (fundFlows.length > 0) {
    lines.push('【近 5 日主力资金流向时序】:');
    for (const f of fundFlows) {
      lines.push(`  - ${f.trade_date}: 主力净流入 ${formatMoney(f.main_net)} (超大单: ${formatMoney(f.super_large_net)}, 大单: ${formatMoney(f.large_net)})`);
    }
  } else {
    lines.push('【近 5 日主力资金流向】暂无入库数据');
  }

  if (events.length > 0) {
    lines.push('【近 7 天关键事件】:');
    for (const e of events) {
      lines.push(`  - [ID:${e.event_id}] [${e.level}] ${e.category} (${e.time}): ${e.summary} [影响评级: ${e.impact}]`);
    }
  } else {
    lines.push('【近 7 天关键事件】暂无新增预警事件');
  }

  if (anns.length > 0) {
    lines.push('【最近披露公告列表】:');
    for (const a of anns) {
      lines.push(`  - [${a.publish_time}] ${a.title} (URL: ${a.ann_url})`);
    }
  }

  const refs = {
    stockCode,
    quoteId: latestQuote ? latestQuote.id : null,
    eventIds: events.map((e) => e.event_id),
    announcementIds: anns.map((a) => a.ann_id),
  };

  return {
    contextPrompt: lines.join('\n'),
    refs,
  };
}

/**
 * 处理用户聊天请求（支持普通同步模式和 SSE 流式输出）
 */
export async function handleConversationChat(req, res, repo, convId, userMessage, isStream = false) {
  const conv = repo.getConversation(convId);
  if (!conv) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: '会话不存在' }));
  }

  // 1. 保存用户提问
  repo.saveMessage({
    conversationId: convId,
    role: 'user',
    content: userMessage,
  });

  // 2. 组装 RAG 上下文
  const { contextPrompt, refs } = buildConversationContext(repo, conv.stock_code);

  // 3. 构建历史对话（保留最近 6 轮，避免超出上下文窗口）
  const history = repo.getMessages(convId, 12);
  const messagesForModel = [
    {
      role: 'system',
      content: `你是一个客观、严谨的 A 股量化与基本面监控助手。
【核心纪律】
1. 只能基于下方【已提供的实时数据事实】进行推理回答，严格禁止凭空臆测或编造未提供的数据。
2. 遇到事实未记录或数据缺失的情况，直接如实指出“暂无相关披露数据”。
3. 在回答最后必须附带声明：“以上分析仅基于系统抓取的客观事实，不构成任何投资建议，股市有风险，入市需谨慎。”

【已提供的实时数据事实】：
${contextPrompt}`,
    },
  ];

  for (const msg of history) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      messagesForModel.push({ role: msg.role, content: msg.content });
    }
  }

  const profile = getLlmProfile('chat');
  if (!profile.endpoint || !profile.apiKey) {
    const fallbackReply = '【系统提示】未配置 LLM_CHAT_ENDPOINT 或 LLM_CHAT_KEY 环境变量，AI 智能对话未启用。请配置后重试。';
    repo.saveMessage({
      conversationId: convId,
      role: 'assistant',
      content: fallbackReply,
      contextRefs: refs,
      status: 'failed',
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, data: { reply: fallbackReply, contextRefs: refs } }));
  }

  // 4. 发起请求
  const reqBody = {
    model: profile.model,
    messages: messagesForModel,
    temperature: 0.3,
    stream: Boolean(isStream),
  };

  // ---- 模式 A：非流式同步返回（优先稳定跑通基础路径） ----
  if (!isStream) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), profile.timeoutMs);

      const response = await fetch(profile.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${profile.apiKey}`,
        },
        body: JSON.stringify(reqBody),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`LLM 服务返回 HTTP ${response.status}`);
      }

      const json = await response.json();
      const reply = json?.choices?.[0]?.message?.content || '无回答内容';

      repo.saveMessage({
        conversationId: convId,
        role: 'assistant',
        content: reply,
        contextRefs: refs,
        status: 'completed',
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, data: { reply, contextRefs: refs } }));
    } catch (err) {
      const errReply = `AI 服务连接失败: ${err.message}`;
      repo.saveMessage({
        conversationId: convId,
        role: 'assistant',
        content: errReply,
        contextRefs: refs,
        status: 'failed',
      });
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: errReply }));
    }
  }

  // ---- 模式 B：SSE 流式传输（带客户端断连与 partial 落库保护） ----
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  let fullReply = '';
  let isFinished = false;

  // 监听客户端主动断开连接
  req.on('close', () => {
    if (!isFinished && fullReply.length > 0) {
      repo.saveMessage({
        conversationId: convId,
        role: 'assistant',
        content: fullReply,
        contextRefs: refs,
        status: 'partial',
      });
    }
  });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), profile.timeoutMs);

    const upstreamRes = await fetch(profile.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.apiKey}`,
      },
      body: JSON.stringify(reqBody),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!upstreamRes.ok || !upstreamRes.body) {
      res.write(`data: ${JSON.stringify({ error: `上游模型报错: ${upstreamRes.status}` })}\n\n`);
      return res.end();
    }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留不完整行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        if (trimmed === 'data: [DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed.slice(5).trim());
          const delta = parsed?.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullReply += delta;
            res.write(`data: ${JSON.stringify({ delta, contextRefs: refs })}\n\n`);
          }
        } catch {
          // 忽略格式解析残损
        }
      }
    }

    isFinished = true;
    repo.saveMessage({
      conversationId: convId,
      role: 'assistant',
      content: fullReply,
      contextRefs: refs,
      status: 'completed',
    });
    res.end();
  } catch (err) {
    if (!isFinished) {
      repo.saveMessage({
        conversationId: convId,
        role: 'assistant',
        content: fullReply || `流式中断: ${err.message}`,
        contextRefs: refs,
        status: fullReply ? 'partial' : 'failed',
      });
    }
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
}
