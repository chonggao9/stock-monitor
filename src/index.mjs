// 主入口：编排「抓取 → 分级 → 入库 → 去重 → 告警」全流程
// 纯 Node 原生 ESM，状态与数据全面持久化入 SQLite (WAL 模式)
import { loadConfig } from './config.mjs';
import { getRepo } from './db/repo.mjs';
import {
  fetchAnnouncements,
  fetchQuote,
  fetchFundFlow,
  fetchMargin,
  fetchLhb,
  fetchBlockTrade,
} from './fetchers.mjs';
import { classifyAnnouncement, classifyQuoteAbnormal, detectDivergence, formatMoney } from './classify.mjs';
import { analyzeEventWithCache } from './llm.mjs';
import { buildOutput, overallLevel } from './output.mjs';
import { sendDingtalk, formatDingtalkMarkdown, shouldPush } from './dingtalk.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { mode: 'realtime', stock: null, jsonOnly: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) out.mode = args[++i];
    else if (args[i] === '--stock' && args[i + 1]) out.stock = args[++i];
    else if (args[i] === '--json') out.jsonOnly = true;
  }
  return out;
}

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let globalAiCount = 0;
const maxAiPerRun = parseInt(process.env.MAX_AI_ANALYSIS_PER_RUN || '5', 10);

/**
 * 处理单只股票的采集流程并入库
 */
async function processStock(stock, config, repo, mode) {
  const checkTime = nowStr();
  const dataSourceIssues = [];
  const pendingData = [];
  const now = new Date();

  // 1. 查询该标的最近一次入库公告的时间，决定查询起点
  const recentAnns = repo.getAnnouncements(stock.code, 1);
  const lookback = new Date(Date.now() - (config.lookbackDays || 3) * 86400 * 1000);
  const startDate = recentAnns.length > 0 ? recentAnns[0].publish_time.slice(0, 10) : dateStr(lookback);
  const endDate = dateStr(now);
  const coveredRange = `${startDate} ~ ${endDate}`;

  // 并行请求：公告、实时行情、资金流向
  const [annResult, quoteResult, fundFlowResult] = await Promise.allSettled([
    fetchAnnouncements(stock.code, startDate, endDate, stock.market, 5),
    fetchQuote(stock),
    fetchFundFlow(stock, 5),
  ]);

  // 处理公告
  let announcements = [];
  if (annResult.status === 'fulfilled') {
    announcements = annResult.value || [];
    if (announcements.length > 0) {
      repo.saveAnnouncements(announcements);
    }
  } else {
    dataSourceIssues.push(`公告接口异常: ${annResult.reason?.message}`);
  }

  // 处理行情
  let quote = null;
  if (quoteResult.status === 'fulfilled') {
    quote = quoteResult.value;
    if (quote) {
      repo.saveQuote(quote);
    }
  } else {
    dataSourceIssues.push(`行情接口异常: ${stock.code}`);
  }

  // 处理资金流
  let fundFlow = null;
  if (fundFlowResult.status === 'fulfilled') {
    const res = fundFlowResult.value;
    if (res && res.latest) {
      fundFlow = res.latest;
      // 批量入库近期资金流
      if (Array.isArray(res.history)) {
        for (const item of res.history) {
          repo.saveFundFlow(item);
        }
      }
    } else {
      pendingData.push(`资金流向未获取（${stock.code}），可能为数据源受限，留待后续补偿`);
    }
  } else {
    dataSourceIssues.push(`资金流向接口异常: ${stock.code}`);
  }

  // ---- 事件分级与入库（以 SQLite events 表持久化，保留黄升红升级推送逻辑） ----
  const events = [];

  // (1) 公告事件分级
  for (const ann of announcements) {
    const cls = classifyAnnouncement(ann.title);
    const eventId = `cninfo:${ann.id}`;
    
    // (1) 公告事件分级与持久化
    const recordRes = repo.recordEvent({
      eventId,
      code: stock.code,
      category: '公告',
      level: cls.level,
      time: ann.time,
      summary: `${ann.title}${cls.keyword ? `（命中：${cls.keyword}）` : ''}`,
      impact: cls.level === '红' ? '利空' : '中性',
      source: '巨潮资讯',
      url: ann.url,
    });

    if (recordRes.isNew) {
      let impact = recordRes.event.impact;
      let summary = recordRes.event.summary;

      // 仅对新入库且为红/黄的事件，且未超出单轮预算时调用 AI 分析
      if ((cls.level === '红' || cls.level === '黄') && globalAiCount < maxAiPerRun) {
        try {
          const aiRes = await analyzeEventWithCache(repo, {
            eventId,
            title: ann.title,
            category: '公告',
            ruleLevel: cls.level,
          });
          if (aiRes) {
            impact = aiRes.sentiment;
            summary = aiRes.summary;
            globalAiCount++;
          }
        } catch {
          // 降级使用规则结果
        }
      }

      events.push({
        event_id: eventId,
        category: '公告',
        level: cls.level,
        time: ann.time,
        summary,
        impact,
        verified: '已证实',
        source: '巨潮资讯',
        url: ann.url,
      });
    }
  }

  // (2) 盘口与资金异动事件
  const abnormal = classifyQuoteAbnormal(quote, config.thresholds);
  if (abnormal) {
    const eventId = `quote:${stock.code}:${quote?.time || checkTime}`;
    const recordRes = repo.recordEvent({
      eventId,
      code: stock.code,
      category: '资金',
      level: abnormal.level,
      time: quote?.time || checkTime,
      summary: abnormal.reason,
      impact: abnormal.level === '红' ? '利空' : '中性',
      source: '腾讯行情',
      url: '',
    });
    if (recordRes.isNew) {
      events.push({
        event_id: eventId,
        category: '资金',
        level: abnormal.level,
        time: quote?.time || checkTime,
        summary: abnormal.reason,
        impact: abnormal.level === '红' ? '利空' : '中性',
        verified: '已证实',
        source: '腾讯行情',
        url: '',
      });
    }
  }

  // (3) 资金与股价背离检测
  const divergence = detectDivergence(quote, fundFlow);
  if (divergence) {
    const eventId = `divergence:${stock.code}:${quote?.time || checkTime}`;
    const recordRes = repo.recordEvent({
      eventId,
      code: stock.code,
      category: '资金',
      level: '黄',
      time: quote?.time || checkTime,
      summary: divergence,
      impact: '中性',
      source: '东财/腾讯',
      url: '',
    });
    if (recordRes.isNew) {
      events.push({
        event_id: eventId,
        category: '资金',
        level: '黄',
        time: quote?.time || checkTime,
        summary: divergence,
        impact: '中性',
        verified: '已证实',
        source: '东财/腾讯',
        url: '',
      });
    }
  }

  // (4) 盘后数据（龙虎榜/大宗/两融）仅在 catchup 模式下全量抓取与入库
  if (mode !== 'realtime') {
    const today = dateStr(now);
    const [lhbRes, btRes, marginRes] = await Promise.allSettled([
      fetchLhb(stock),
      fetchBlockTrade(stock),
      fetchMargin(stock),
    ]);

    // 龙虎榜
    if (lhbRes.status === 'fulfilled') {
      const lhbs = lhbRes.value || [];
      const lhbToday = lhbs.find((x) => x.tradeDate === today);
      if (lhbToday) {
        repo.savePostMarketData({
          code: stock.code,
          tradeDate: lhbToday.tradeDate,
          dataType: 'lhb',
          summary: `登上龙虎榜（${lhbToday.explanation || '异动'}），净额${formatMoney(lhbToday.netAmount)}`,
          detail: lhbToday,
        });
        const eventId = `lhb:${stock.code}:${lhbToday.tradeDate}`;
        const recordRes = repo.recordEvent({
          eventId,
          code: stock.code,
          category: '资金',
          level: '黄',
          time: lhbToday.tradeDate,
          summary: `登上龙虎榜（${lhbToday.explanation || '异动'}），买入${formatMoney(lhbToday.buyAmount)}，卖出${formatMoney(lhbToday.sellAmount)}，净额${formatMoney(lhbToday.netAmount)}`,
          impact: '中性',
          source: '东方财富',
        });
        if (recordRes.isNew) events.push(recordRes.event);
      }
    } else {
      pendingData.push(`龙虎榜未获取（${stock.code}）`);
    }

    // 大宗交易
    if (btRes.status === 'fulfilled') {
      const bts = btRes.value || [];
      const btToday = bts.find((x) => x.tradeDate === today);
      if (btToday) {
        repo.savePostMarketData({
          code: stock.code,
          tradeDate: btToday.tradeDate,
          dataType: 'block_trade',
          summary: `大宗交易：买方[${btToday.buyer}]→卖方[${btToday.seller}]，成交价${btToday.dealPrice}，折溢价${btToday.premiumRatio ? (btToday.premiumRatio * 100).toFixed(2) + '%' : '未披露'}`,
          detail: btToday,
        });
        const eventId = `blocktrade:${stock.code}:${btToday.tradeDate}`;
        const recordRes = repo.recordEvent({
          eventId,
          code: stock.code,
          category: '资金',
          level: '黄',
          time: btToday.tradeDate,
          summary: `大宗交易：${btToday.buyer}→${btToday.seller}，折溢价${btToday.premiumRatio ? (btToday.premiumRatio * 100).toFixed(2) + '%' : '未披露'}，成交额${formatMoney(btToday.dealAmount)}`,
          impact: '中性',
          source: '东方财富',
        });
        if (recordRes.isNew) events.push(recordRes.event);
      }
    } else {
      pendingData.push(`大宗交易未获取（${stock.code}）`);
    }

    // 融资融券
    if (marginRes.status === 'fulfilled') {
      const margins = marginRes.value || [];
      const marginLatest = margins[0];
      const marginThreshold = config.thresholds?.margin_change ?? 5e7;
      if (marginLatest) {
        repo.savePostMarketData({
          code: stock.code,
          tradeDate: marginLatest.date,
          dataType: 'margin',
          summary: `融资余额${formatMoney(marginLatest.financeBalance)}，净买入${formatMoney(marginLatest.financeNetBuy)}`,
          detail: marginLatest,
        });
        if (Math.abs(marginLatest.financeNetBuy) >= marginThreshold) {
          const eventId = `margin:${stock.code}:${marginLatest.date}`;
          const amtStr = formatMoney(Math.abs(marginLatest.financeNetBuy));
          const summary = `融资余额单日${marginLatest.financeNetBuy > 0 ? '净买入' : '净卖出'}${amtStr}（总余额${formatMoney(marginLatest.financeBalance)}）`;
          const recordRes = repo.recordEvent({
            eventId,
            code: stock.code,
            category: '资金',
            level: '黄',
            time: marginLatest.date,
            summary,
            impact: '中性',
            source: '东方财富',
          });
          if (recordRes.isNew) events.push(recordRes.event);
        }
      }
    } else {
      pendingData.push(`融资融券未获取（${stock.code}）`);
    }
  }

  // 组装输出
  const lvl = overallLevel(events);
  const headline = lvl === '无新增'
    ? `${stock.name} 无新增`
    : events.filter((e) => e.level === '红' || e.level === '黄').slice(0, 1).map((e) => e.summary).join(' ｜ ').slice(0, 60);

  const fundFlowSnapshot = {
    price_change: quote ? `${quote.changePct}%` : '未获取',
    main_net: fundFlow ? formatMoney(fundFlow.mainNet) : null,
    super_large_net: fundFlow ? formatMoney(fundFlow.superLargeNet) : null,
    large_net: fundFlow ? formatMoney(fundFlow.largeNet) : null,
    volume_ratio: quote ? quote.volumeRatio : null,
    divergence: divergence || '无',
  };

  const watchNext = [];
  if (events.some((e) => e.level === '红')) watchNext.push('关注红色重大事件后续进展');
  if (pendingData.length) watchNext.push('关注盘后数据补爬披露（龙虎榜/两融/大宗）');

  return buildOutput({
    stock,
    checkTime,
    mode,
    coveredRange,
    overallLevel: lvl,
    headline,
    events,
    fundFlowSnapshot,
    pendingData,
    dataSourceIssues,
    watchNext,
    lastSuccessTimestamp: checkTime,
  });
}

/**
 * 并发限制调度器
 */
async function mapConcurrent(items, limit, fn) {
  const results = [];
  const executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    if (limit <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

async function main() {
  const args = parseArgs();
  const config = loadConfig();
  const repo = getRepo();

  // 1. 如果数据库为空，先从 config.json 播种初始股票标的
  repo.seedStocksIfEmpty(config.stocks);

  // 2. 获取标的（以数据库中 enabled = 1 为准）
  let stocks = [];
  if (args.stock) {
    const found = repo.getStock(args.stock);
    if (!found) {
      console.error(`未在数据库中找到股票 ${args.stock}`);
      process.exit(1);
    }
    stocks = [found];
  } else {
    stocks = repo.getEnabledStocks();
  }

  if (stocks.length === 0) {
    console.log('当前没有处于启用状态的监控标的（enabled=1），流程结束。');
    return;
  }

  // 3. 记录 pipeline_run
  const runId = repo.startPipelineRun({ mode: args.mode, targetCode: args.stock || null });
  const allIssues = [];

  // 4. 并发限制执行（控制最大并发为 3，兼顾速度与避免触发反爬）
  const results = await mapConcurrent(stocks, 3, async (stock) => {
    try {
      const r = await processStock(stock, config, repo, args.mode);
      if (r.data_source_issues && r.data_source_issues.length) {
        allIssues.push(...r.data_source_issues);
      }
      return r;
    } catch (e) {
      const errMsg = `${stock.code} 处理异常: ${e.message}`;
      allIssues.push(errMsg);
      return buildOutput({
        stock,
        checkTime: nowStr(),
        mode: args.mode,
        coveredRange: '',
        overallLevel: '无新增',
        headline: `${stock.name} 处理异常`,
        events: [],
        fundFlowSnapshot: {},
        pendingData: [],
        dataSourceIssues: [errMsg],
        watchNext: [],
        lastSuccessTimestamp: nowStr(),
      });
    }
  });

  // 5. 更新 pipeline_run 状态
  const runStatus = allIssues.length === 0 ? 'success' : (allIssues.length < stocks.length ? 'partial' : 'failed');
  repo.finishPipelineRun(runId, {
    status: runStatus,
    issues: allIssues,
    summary: `完成 ${stocks.length} 只标的抓取，产生事件 ${results.reduce((acc, r) => acc + r.events.length, 0)} 条`,
  });

  // 6. 钉钉推送
  const dt = config.dingtalk || {};
  const pushResults = [];
  if (dt.enabled && dt.webhook) {
    const toPush = results.filter((r) => shouldPush(r, dt.pushLevel));
    for (const r of toPush) {
      const text = formatDingtalkMarkdown(r);
      const resp = await sendDingtalk(dt.webhook, dt.secret, text, `${r.stock} ｜ ${r.overall_level}`);
      if (resp.ok) {
        pushResults.push(`${r.stock} 已推送`);
      } else {
        pushResults.push(`${r.stock} 推送失败: ${resp.errmsg}`);
      }
    }
    if (toPush.length === 0) pushResults.push('无达到推送级别的标的');
  }

  // 7. 输出
  if (args.jsonOnly) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n===== ${r.stock} | ${r.mode} | ${r.overall_level} =====`);
      console.log(`标题: ${r.headline}`);
      for (const e of r.events) {
        console.log(`  [${e.level}] ${e.category} ${e.time} ${e.summary}`);
      }
      if (r.pending_data.length) console.log(`  待披露: ${r.pending_data.join('；')}`);
      if (r.data_source_issues.length) console.log(`  数据源异常: ${r.data_source_issues.join('；')}`);
    }
    if (pushResults.length) {
      console.log(`\n--- 钉钉推送 ---`);
      for (const p of pushResults) console.log(`  ${p}`);
    }
    console.log(`\n--- 运行摘要: 状态 [${runStatus}], 批次ID #${runId} ---`);
  }
}

main().catch((e) => {
  console.error('运行失败:', e);
  process.exit(1);
});
