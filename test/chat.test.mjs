// 对话上下文组装测试：验证 RAG 动态注入、引用提取与 System Prompt 约束
import test from 'node:test';
import assert from 'node:assert/strict';
import { getRepo } from '../src/db/repo.mjs';
import { buildConversationContext } from '../src/chat.mjs';

test('AI 对话上下文组装与引用测试', () => {
  const repo = getRepo();
  // 确保标的存在
  repo.upsertStock({ code: '600703', name: '三安光电', market: 'sh', enabled: 1, notes: '光电芯片龙头' });

  const { contextPrompt, refs } = buildConversationContext(repo, '600703');

  // 验证注入文本包含了标的基本面与关键信息
  assert.ok(contextPrompt.includes('三安光电'));
  assert.ok(contextPrompt.includes('光电芯片龙头'));
  assert.ok(contextPrompt.includes('最新行情快照'));
  assert.ok(contextPrompt.includes('近 5 日主力资金流向'));
  assert.ok(contextPrompt.includes('近 7 天关键事件'));

  // 验证引用 ID 列表
  assert.equal(refs.stockCode, '600703');
  assert.ok(Array.isArray(refs.eventIds));
  assert.ok(Array.isArray(refs.announcementIds));
});
