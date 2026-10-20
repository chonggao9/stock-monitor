// LLM 模块：OpenAI 兼容协议封装，支持 analysis / chat 双 profile 与缓存
import { httpPost } from './http.mjs';

export const PROMPT_VERSIONS = {
  EVENT_ANALYSIS: 'v1.0',
  CHAT_SYSTEM: 'v1.0',
};

/**
 * 获取 LLM 配置 Profile（优先从环境变量读取，保证敏感 Key 不落入代码和配置文件）
 * @param {'analysis' | 'chat'} profile
 */
export function getLlmProfile(profile = 'analysis') {
  if (profile === 'analysis') {
    return {
      endpoint: process.env.LLM_ANALYSIS_ENDPOINT || process.env.LLM_ENDPOINT || '',
      apiKey: process.env.LLM_ANALYSIS_KEY || process.env.LLM_API_KEY || '',
      model: process.env.LLM_ANALYSIS_MODEL || process.env.LLM_MODEL || 'deepseek-chat',
      timeoutMs: parseInt(process.env.LLM_ANALYSIS_TIMEOUT || '20000', 10),
      maxPerRun: parseInt(process.env.MAX_AI_ANALYSIS_PER_RUN || '5', 10), // 单轮运行最大分析次数上限
    };
  }
  return {
    endpoint: process.env.LLM_CHAT_ENDPOINT || process.env.LLM_ENDPOINT || '',
    apiKey: process.env.LLM_CHAT_KEY || process.env.LLM_API_KEY || '',
    model: process.env.LLM_CHAT_MODEL || process.env.LLM_MODEL || 'deepseek-chat',
    timeoutMs: parseInt(process.env.LLM_CHAT_TIMEOUT || '45000', 10),
  };
}

/**
 * 针对单条事件执行 AI 结构化分析，带 SQLite 缓存与版本控制
 */
export async function analyzeEventWithCache(repo, { eventId, title, category, ruleLevel }) {
  const profile = getLlmProfile('analysis');
  const promptVer = PROMPT_VERSIONS.EVENT_ANALYSIS;
  const targetType = 'event';

  // 1. 若未配置 API Key 或 Endpoint，直接跳过
  if (!profile.endpoint || !profile.apiKey) {
    return null;
  }

  // 2. 先查缓存
  const cached = repo.getAiAnalysis(targetType, eventId, profile.model, promptVer);
  if (cached) {
    return {
      sentiment: cached.sentiment,
      summary: cached.summary,
      confidence: cached.confidence,
      source: 'cache',
    };
  }

  // 3. 构建 Prompt 并请求 LLM
  const systemPrompt = `你是一个资深 A 股量化与基本面分析师。请对给出的上市公司事件做简短客观的情绪与影响研判。
必须严格输出纯 JSON 对象，格式如下：
{
  "sentiment": "利好" | "利空" | "中性",
  "summary": "不超过40字的核心影响摘要",
  "confidence": 0.0 到 1.0 之间的置信度
}
禁止输出任何解释、Markdown 代码块或其它非 JSON 内容。`;

  const userContent = JSON.stringify({
    title,
    category,
    rule_level: ruleLevel,
  });

  try {
    const bodyStr = JSON.stringify({
      model: profile.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.1,
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), profile.timeoutMs);

    const res = await fetch(profile.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.apiKey}`,
      },
      body: bodyStr,
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';

    // 解析结构化 JSON
    const parsed = extractJsonObject(content);
    if (!parsed || !parsed.sentiment) return null;

    const sentiment = ['利好', '利空', '中性'].includes(parsed.sentiment) ? parsed.sentiment : '中性';
    const summary = String(parsed.summary || title).slice(0, 100);
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.8;

    // 写入数据库缓存
    repo.saveAiAnalysis({
      targetType,
      targetId: eventId,
      model: profile.model,
      promptVer,
      sentiment,
      summary,
      confidence,
      rawOutput: content,
    });

    return { sentiment, summary, confidence, source: 'llm' };
  } catch (err) {
    // 超时或失败静默降级，不阻断主链路
    return null;
  }
}

/**
 * 容错提取 JSON 对象（兼容包含 markdown 围栏或前后杂质文字的情况）
 */
function extractJsonObject(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}
