// 规则引擎分级：基于关键词与阈值，对公告和资金异动做红/黄/绿分级
// 这是 LLM 未启用时的降级方案，也是 LLM 分级前的初筛

// 反向排除关键词（包含以下词汇的公告，不误判为红色恶性事件）
const EXCLUDE_RED_KEYWORDS = [
  '终止减持', '未减持', '承诺不减持', '不减持',
  '解除质押', '质押解除', '解除冻结', '冻结解除',
  '撤销风险警示', '撤销退市风险警示', '撤销*ST', '撤销ST',
  '诉讼进展', '诉讼和解',
];

const RED_KEYWORDS = [
  '破产重整', '破产清算', '退市', '暂停上市', '终止上市', '风险警示', '*ST', '被ST',
  '立案调查', '留置', '刑事', '被调查', '处罚', '罚没', '罚款',
  '监管函', '问询函', '警示函', '纪律处分',
  '重大诉讼', '仲裁', '债务逾期', '冻结', '轮候冻结', '质押', '平仓', '强制执行',
  '预亏', '亏损', '下修', '业绩变脸', '业绩修正',
  '减持', '违规担保', '资金占用', '占用',
  '非标', '审计', '财务造假', '虚假记载', '重大差错',
  '停牌',
];

const YELLOW_KEYWORDS = [
  '业绩预告', '业绩快报', '季度报告', '年度报告', '半年度报告', '定期报告',
  '重大合同', '中标',
  '定增', '非公开发行', '可转债', '发行股票', '募集资金',
  '回购', '增持',
  '股权激励', '员工持股',
  '解禁', '限售', '上市流通',
  '高管', '辞职', '聘任', '人事',
  '关联交易', '分红', '派息', '权益分派',
  '重组', '并购', '收购', '资产置换',
  '终止减持', '解除质押',
];

/**
 * 格式化以“元”为单位的金额为易读的“万元”或“亿元”
 */
export function formatMoney(val) {
  if (val === undefined || val === null || Number.isNaN(val)) return '0元';
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e8) {
    return `${sign}${(abs / 1e8).toFixed(2)}亿元`;
  }
  if (abs >= 1e4) {
    return `${sign}${(abs / 1e4).toFixed(2)}万元`;
  }
  return `${sign}${Math.round(abs)}元`;
}

/**
 * 对公告标题做关键词分级。
 * 返回 { level, category, keyword }
 */
export function classifyAnnouncement(title) {
  const t = title || '';
  
  // 1. 检查是否存在反向排除词（例如“终止减持”或“解除质押”不应被定为红）
  for (const ex of EXCLUDE_RED_KEYWORDS) {
    if (t.includes(ex)) {
      return { level: '黄', category: '公告', keyword: `中性进展:${ex}` };
    }
  }

  // 2. 匹配红色严重关键词
  for (const kw of RED_KEYWORDS) {
    if (t.includes(kw)) return { level: '红', category: '公告', keyword: kw };
  }

  // 3. 匹配黄色关注关键词
  for (const kw of YELLOW_KEYWORDS) {
    if (t.includes(kw)) return { level: '黄', category: '公告', keyword: kw };
  }

  // 4. 常规公告
  return { level: '绿', category: '公告', keyword: '' };
}

/**
 * 基于行情快照判断资金/盘口异动。
 */
export function classifyQuoteAbnormal(quote, thresholds = {}) {
  if (!quote || quote.price == null) return null;
  const { fast_move_pct = 3, volume_ratio = 2 } = thresholds;
  const pct = quote.changePct ?? 0;

  // 涨停/跌停
  if (quote.limitUp && quote.price >= quote.limitUp * 0.999) {
    return { level: '红', category: '资金', reason: `触及涨停 (${quote.price})` };
  }
  if (quote.limitDown && quote.price <= quote.limitDown * 1.001) {
    return { level: '红', category: '资金', reason: `触及跌停 (${quote.price})` };
  }

  // 快速拉升/跳水
  if (Math.abs(pct) >= fast_move_pct) {
    return {
      level: '黄',
      category: '资金',
      reason: `${pct >= 0 ? '大幅拉升' : '大幅跳水'} ${pct.toFixed(2)}%`,
    };
  }

  // 量比放大
  if (quote.volumeRatio && quote.volumeRatio >= volume_ratio) {
    return { level: '黄', category: '资金', reason: `量比放大至 ${quote.volumeRatio.toFixed(1)}` };
  }

  return null;
}

/**
 * 判断资金流向与股价是否背离（主力净流入但股价跌，或主力净流出但股价涨）。
 */
export function detectDivergence(quote, fundFlow) {
  if (!quote || !fundFlow || fundFlow.mainNet == null) return null;
  const mainNet = fundFlow.mainNet;
  const pct = quote.changePct ?? 0;
  const formattedFlow = formatMoney(mainNet);

  if (mainNet > 0 && pct < -1) {
    return `股价跌${pct.toFixed(2)}%但主力净流入${formattedFlow}，出现底部背离吸筹特征`;
  }
  if (mainNet < 0 && pct > 1) {
    return `股价涨${pct.toFixed(2)}%但主力净流出${formattedFlow}，出现冲高背离出货特征`;
  }
  return null;
}
