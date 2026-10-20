// 规则引擎单元测试：验证关键词分级、反向排除词防误杀、金额格式化与背离检测
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAnnouncement,
  classifyQuoteAbnormal,
  detectDivergence,
  formatMoney,
} from '../src/classify.mjs';

test('1. 反向排除词防误杀测试', () => {
  // 普通减持公告 -> 红色
  const r1 = classifyAnnouncement('关于控股股东减持股份计划的预披露公告');
  assert.equal(r1.level, '红');

  // 终止减持公告 -> 黄色（中性进展，防误杀为红）
  const r2 = classifyAnnouncement('关于控股股东提前终止减持计划暨减持结果公告');
  assert.equal(r2.level, '黄');

  // 解除质押公告 -> 黄色（防误杀为红）
  const r3 = classifyAnnouncement('关于控股股东部分股份解除质押的公告');
  assert.equal(r3.level, '黄');

  // 违规处罚公告 -> 红色
  const r4 = classifyAnnouncement('关于收到中国证券监督管理委员会立案调查通知书的公告');
  assert.equal(r4.level, '红');
  assert.equal(r4.keyword, '立案调查');

  // 普通日常公告 -> 绿色
  const r5 = classifyAnnouncement('关于召开2026年第一次临时股东大会的通知');
  assert.equal(r5.level, '绿');
});

test('2. 资金金额格式化 formatMoney 测试', () => {
  assert.equal(formatMoney(150000000), '1.50亿元');
  assert.equal(formatMoney(-38000000), '-3800.00万元');
  assert.equal(formatMoney(8500), '8500元');
  assert.equal(formatMoney(null), '0元');
  assert.equal(formatMoney(undefined), '0元');
});

test('3. 行情异动与资金背离检测', () => {
  // 涨跌停
  const quoteLimitUp = { price: 10.0, limitUp: 10.0, changePct: 10.0 };
  const rLimit = classifyQuoteAbnormal(quoteLimitUp);
  assert.equal(rLimit.level, '红');
  assert.match(rLimit.reason, /触及涨停/);

  // 资金与股价背离（股价跌但主力大额净流入）
  const quoteDown = { changePct: -2.5 };
  const flowIn = { mainNet: 80000000 };
  const div = detectDivergence(quoteDown, flowIn);
  assert.ok(div);
  assert.match(div, /底部背离/);
});
