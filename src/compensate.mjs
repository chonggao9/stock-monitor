// 数据补偿模块（Compensate / Backfill）：对历史未爬取成功或遗漏的内容进行补偿爬取与入库
import { getRepo } from './db/repo.mjs';
import {
  fetchAnnouncements,
  fetchFundFlow,
  fetchMargin,
  fetchLhb,
  fetchBlockTrade,
} from './fetchers.mjs';
import { classifyAnnouncement, formatMoney } from './classify.mjs';

function dateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 执行数据补偿任务
 * @param {Object} options
 * @param {string} [options.code] 指定标的代码（为空则补偿全部已启用股票）
 * @param {string} [options.startDate] 开始日期 (YYYY-MM-DD)，默认 14 天前
 * @param {string} [options.endDate] 结束日期 (YYYY-MM-DD)，默认今天
 * @param {string[]} [options.modules] 要补偿的模块: ['announcements', 'fund_flow', 'post_market']
 * @param {boolean} [options.retryFailedRuns] 是否自动重试最近失败的 pipeline_runs 标的
 */
export async function runCompensation(options = {}) {
  const repo = getRepo();
  const runId = repo.startPipelineRun({ mode: 'compensate', targetCode: options.code || null });
  const issues = [];
  const summaryParts = [];

  const now = new Date();
  const defaultStart = dateStr(new Date(Date.now() - 14 * 86400 * 1000));
  const startDate = options.startDate || defaultStart;
  const endDate = options.endDate || dateStr(now);
  const modules = options.modules || ['announcements', 'fund_flow', 'post_market'];

  let targetStocks = [];
  if (options.code) {
    const s = repo.getStock(options.code);
    if (s) targetStocks = [s];
    else {
      const err = `未找到股票代码: ${options.code}`;
      repo.finishPipelineRun(runId, { status: 'failed', issues: [err], summary: err });
      return { success: false, issues: [err] };
    }
  } else {
    targetStocks = repo.getEnabledStocks();
  }

  console.log(`[补偿任务] 开始执行补偿任务，标的数: ${targetStocks.length}，时间跨度: ${startDate} ~ ${endDate}，模块: ${modules.join(', ')}`);

  let totalAnnouncements = 0;
  let totalFundFlows = 0;
  let totalPostMarket = 0;
  let newEventsCount = 0;

  for (const stock of targetStocks) {
    console.log(`[补偿任务] 正在补偿 ${stock.name} (${stock.code})...`);

    // 1. 公告补查 (历史多页深度抓取)
    if (modules.includes('announcements')) {
      try {
        const anns = await fetchAnnouncements(stock.code, startDate, endDate, stock.market, 10);
        if (anns.length > 0) {
          const inserted = repo.saveAnnouncements(anns);
          totalAnnouncements += inserted;

          // 为补爬到的历史公告补充入库事件（若尚未记录）
          for (const a of anns) {
            const cls = classifyAnnouncement(a.title);
            const eventId = `cninfo:${a.id}`;
            const res = repo.recordEvent({
              eventId,
              code: stock.code,
              category: '公告',
              level: cls.level,
              time: a.time,
              summary: `${a.title}${cls.keyword ? `（命中：${cls.keyword}）` : ''}`,
              impact: cls.level === '红' ? '利空' : '中性',
              source: '巨潮资讯(补偿)',
              url: a.url,
            });
            if (res.isNew) newEventsCount++;
          }
        }
      } catch (err) {
        issues.push(`${stock.code} 公告补偿失败: ${err.message}`);
      }
    }

    // 2. 资金流向历史补查 (多日回溯)
    if (modules.includes('fund_flow')) {
      try {
        const flowResult = await fetchFundFlow(stock, 60); // 拉取最近 60 个交易日
        if (flowResult && flowResult.history) {
          let flowSaved = 0;
          for (const item of flowResult.history) {
            // 过滤在 [startDate, endDate] 区间的数据
            if (item.date >= startDate && item.date <= endDate) {
              repo.saveFundFlow(item);
              flowSaved++;
            }
          }
          totalFundFlows += flowSaved;
        }
      } catch (err) {
        issues.push(`${stock.code} 资金流向补偿失败: ${err.message}`);
      }
    }

    // 3. 盘后交易补查（龙虎榜、大宗、两融）
    if (modules.includes('post_market')) {
      // 龙虎榜
      try {
        const lhbs = await fetchLhb(stock);
        for (const item of lhbs) {
          if (item.tradeDate >= startDate && item.tradeDate <= endDate) {
            repo.savePostMarketData({
              code: stock.code,
              tradeDate: item.tradeDate,
              dataType: 'lhb',
              summary: `龙虎榜：${item.explanation || '异动'}，买入${formatMoney(item.buyAmount)}，卖出${formatMoney(item.sellAmount)}，净额${formatMoney(item.netAmount)}`,
              detail: item,
            });
            totalPostMarket++;
          }
        }
      } catch (err) {
        issues.push(`${stock.code} 龙虎榜补偿失败: ${err.message}`);
      }

      // 大宗交易
      try {
        const bts = await fetchBlockTrade(stock);
        for (const item of bts) {
          if (item.tradeDate >= startDate && item.tradeDate <= endDate) {
            repo.savePostMarketData({
              code: stock.code,
              tradeDate: item.tradeDate,
              dataType: 'block_trade',
              summary: `大宗交易：买方[${item.buyer}]→卖方[${item.seller}]，成交价${item.dealPrice}，成交量${item.dealVolume}股，金额${formatMoney(item.dealAmount)}`,
              detail: item,
            });
            totalPostMarket++;
          }
        }
      } catch (err) {
        issues.push(`${stock.code} 大宗交易补偿失败: ${err.message}`);
      }

      // 融资融券
      try {
        const margins = await fetchMargin(stock);
        for (const item of margins) {
          if (item.date >= startDate && item.date <= endDate) {
            repo.savePostMarketData({
              code: stock.code,
              tradeDate: item.date,
              dataType: 'margin',
              summary: `融资融券：融资余额${formatMoney(item.financeBalance)}，净买入${formatMoney(item.financeNetBuy)}`,
              detail: item,
            });
            totalPostMarket++;
          }
        }
      } catch (err) {
        issues.push(`${stock.code} 两融补偿失败: ${err.message}`);
      }
    }
  }

  summaryParts.push(`补偿新录入公告 ${totalAnnouncements} 条`);
  summaryParts.push(`资金流向时序 ${totalFundFlows} 条`);
  summaryParts.push(`盘后数据 ${totalPostMarket} 条`);
  summaryParts.push(`生成/更新事件 ${newEventsCount} 个`);
  const finalSummary = summaryParts.join('；');

  const status = issues.length === 0 ? 'success' : (totalAnnouncements > 0 || totalFundFlows > 0 ? 'partial' : 'failed');
  repo.finishPipelineRun(runId, { status, issues, summary: finalSummary });

  console.log(`[补偿任务] 执行完成。结果: ${finalSummary}。异常源: ${issues.length}个`);

  return {
    success: status !== 'failed',
    status,
    totalAnnouncements,
    totalFundFlows,
    totalPostMarket,
    newEventsCount,
    issues,
    summary: finalSummary,
  };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/compensate.mjs')) {
  const args = process.argv.slice(2);
  let code = null;
  let days = 14;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stock' && args[i + 1]) code = args[++i];
    if (args[i] === '--days' && args[i + 1]) days = parseInt(args[++i], 10);
  }
  const start = dateStr(new Date(Date.now() - days * 86400 * 1000));
  runCompensation({ code, startDate: start }).catch((err) => {
    console.error('补偿运行失败:', err);
    process.exit(1);
  });
}
