// 数据抓取模块：巨潮公告（多页+本地缓存）、腾讯行情、东财资金/两融/龙虎榜/大宗
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { httpGet, httpPost } from './http.mjs';
import { marketPrefix, eastmoneySecId, ROOT } from './config.mjs';

// ---------- 巨潮公告 ----------
function tsToStr(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const orgIdCache = new Map();
const SZSE_CACHE_FILE = resolve(ROOT, 'data/szse_map.json');
const CACHE_TTL_MS = 7 * 86400 * 1000; // 7天缓存

async function loadSzseOrgIdMap() {
  // 1. 尝试从本地缓存读取
  try {
    if (existsSync(SZSE_CACHE_FILE)) {
      const stat = statSync(SZSE_CACHE_FILE);
      if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
        const raw = JSON.parse(readFileSync(SZSE_CACHE_FILE, 'utf-8'));
        const map = new Map(Object.entries(raw));
        if (map.size > 0) return map;
      }
    }
  } catch (err) {
    // 忽略缓存读取错误，继续走网络请求
  }

  // 2. 从网络拉取并持久化
  const url = 'http://www.cninfo.com.cn/new/data/szse_stock.json';
  const txt = await httpGet(url, { headers: { Referer: 'http://www.cninfo.com.cn/' }, timeout: 20000 });
  const json = JSON.parse(txt);
  const list = json.stockList || json || [];
  const map = new Map();
  const obj = {};
  for (const item of list) {
    if (item && item.code && item.orgId) {
      map.set(item.code, item.orgId);
      obj[item.code] = item.orgId;
    }
  }

  try {
    mkdirSync(dirname(SZSE_CACHE_FILE), { recursive: true });
    writeFileSync(SZSE_CACHE_FILE, JSON.stringify(obj), 'utf-8');
  } catch (err) {
    // 写入失败不影响主流程
  }

  return map;
}

let szseOrgIdPromise = null;

export async function getOrgId(code, market) {
  if (orgIdCache.has(code)) return orgIdCache.get(code);
  if (market === 'sh') {
    const orgId = `gssh0${code}`;
    orgIdCache.set(code, orgId);
    return orgId;
  }
  if (!szseOrgIdPromise) szseOrgIdPromise = loadSzseOrgIdMap();
  const map = await szseOrgIdPromise;
  const orgId = map.get(code) || null;
  if (orgId) orgIdCache.set(code, orgId);
  return orgId;
}

/**
 * 抓取某只股票在 [startDate, endDate] 期间的公告列表。
 * 支持多页循环抓取（maxPages 默认 5），彻底避免公告截断。
 */
export async function fetchAnnouncements(code, startDate, endDate, market, maxPages = 5) {
  const orgId = await getOrgId(code, market);
  const stockParam = orgId ? `${code},${orgId}` : code;
  const allAnnouncements = [];

  for (let page = 1; page <= maxPages; page++) {
    const body = new URLSearchParams({
      pageNum: String(page),
      pageSize: '50',
      column: 'szse',
      tabName: 'fulltext',
      plate: '',
      stock: stockParam,
      searchkey: '',
      secid: '',
      category: '',
      trade: '',
      seDate: `${startDate}~${endDate}`,
      sortName: '',
      sortType: '',
      isHLtitle: 'true',
    }).toString();

    const txt = await httpPost('http://www.cninfo.com.cn/new/hisAnnouncement/query', body, {
      headers: { Referer: 'http://www.cninfo.com.cn/' },
      timeout: 15000,
    });

    const json = JSON.parse(txt);
    const list = json.announcements || [];
    if (!Array.isArray(list) || list.length === 0) break;

    for (const a of list) {
      allAnnouncements.push({
        code,
        title: a.announcementTitle ? a.announcementTitle.replace(/<[^>]+>/g, '').trim() : '',
        time: tsToStr(a.announcementTime),
        ts: a.announcementTime,
        id: a.announcementId,
        url: a.adjunctUrl
          ? `https://static.cninfo.com.cn/${a.adjunctUrl}`
          : `https://www.cninfo.com.cn/new/disclosure/detail?stockCode=${code}&announcementId=${a.announcementId}`,
      });
    }

    // 若当前页不满 50 条或 hasMore 为 false，说明已经拉完全部
    if (list.length < 50 || json.hasMore === false) break;

    // 合规限速：多页请求之间增加 300ms 礼貌延迟，防止触发巨潮接口频控
    await new Promise((r) => setTimeout(r, 300));
  }

  return allAnnouncements;
}

// ---------- 腾讯行情 ----------
function decodeGbk(buf) {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/**
 * 腾讯实时行情，统一采用 httpGet 带超时封装，并做空字段与防御性解析
 */
export async function fetchQuote(stock) {
  const sym = `${marketPrefix(stock.market)}${stock.code}`;
  const url = `https://qt.gtimg.cn/q=${sym}`;
  
  let txt;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    txt = decodeGbk(buf);
  } catch {
    return null;
  }

  const m = txt.match(/="([^"]*)"/);
  if (!m) return null;
  const f = m[1].split('~');
  if (f.length < 40 || !f[3] || f[3] === '0.00' && f[6] === '0') {
    // 字段不足或无效
    if (!f[3]) return null;
  }

  const parseNum = (v, defaultVal = null) => {
    if (v === undefined || v === null || v === '') return defaultVal;
    const n = parseFloat(v);
    return Number.isNaN(n) ? defaultVal : n;
  };

  const parseInteger = (v, defaultVal = 0) => {
    if (!v) return defaultVal;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? defaultVal : n;
  };

  return {
    code: f[2] || stock.code,
    name: f[1] || stock.name,
    price: parseNum(f[3]),
    prevClose: parseNum(f[4]),
    open: parseNum(f[5]),
    changePct: parseNum(f[32]),
    high: parseNum(f[33]),
    low: parseNum(f[34]),
    volumeHand: parseInteger(f[6]), // 手
    amountWan: parseNum(f[37]), // 万元
    turnoverRate: parseNum(f[38]), // %
    amplitude: parseNum(f[43]), // %
    floatCapYi: parseNum(f[44]), // 流通市值 亿
    totalCapYi: parseNum(f[45]), // 总市值 亿
    pb: parseNum(f[46]),
    limitUp: parseNum(f[47]),
    limitDown: parseNum(f[48]),
    volumeRatio: parseNum(f[49]), // 量比
    high52w: parseNum(f[66]),
    low52w: parseNum(f[67]),
    time: f[30] || new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
}

/**
 * 根据 6 位股票代码自动推导所属市场并从行情接口探测真实公司名称
 */
export async function detectStockMarketAndName(code) {
  const c = String(code).trim();
  if (!/^\d{6}$/.test(c)) {
    throw new Error('股票代码必须为 6 位数字');
  }

  // 1. 根据 A 股编号规则推导主市场
  let market = 'sz';
  if (c.startsWith('6') || c.startsWith('9')) {
    market = 'sh';
  } else if (c.startsWith('0') || c.startsWith('3')) {
    market = 'sz';
  }

  // 2. 尝试从腾讯行情接口获取股票信息
  let q = await fetchQuote({ code: c, market });
  if (!q || !q.name || q.name.includes('none_match')) {
    // 兜底尝试另一个市场
    const altMarket = market === 'sh' ? 'sz' : 'sh';
    const altQ = await fetchQuote({ code: c, market: altMarket });
    if (altQ && altQ.name && !altQ.name.includes('none_match')) {
      return { code: c, name: altQ.name, market: altMarket, initialQuote: altQ };
    }
    throw new Error(`未找到股票代码 [${c}]，请确认代码是否输入正确`);
  }

  return { code: c, name: q.name, market, initialQuote: q };
}

// ---------- 东财数据中心通用请求 ----------
async function eastmoneyReport(reportName, filter, opts = {}) {
  const params = new URLSearchParams({
    reportName,
    columns: 'ALL',
    filter,
    pageNumber: String(opts.pageNumber ?? 1),
    pageSize: String(opts.pageSize ?? 5),
    sortTypes: '-1',
    sortColumns: opts.sortColumns ?? 'TRADE_DATE',
  });
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${params.toString()}`;
  const txt = await httpGet(url, { headers: { Referer: 'https://data.eastmoney.com/' }, timeout: 15000 });
  const json = JSON.parse(txt);
  if (!json.result || !json.result.data) return [];
  return json.result.data;
}

// 融资融券
export async function fetchMargin(stock) {
  const filter = `(scode="${stock.code}")`;
  const rows = await eastmoneyReport('RPTA_WEB_RZRQ_GGMX', filter, {
    pageSize: 5,
    sortColumns: 'date',
  });
  return rows.map((r) => ({
    code: stock.code,
    date: String(r.DATE || '').slice(0, 10),
    financeBalance: r.RZYE ?? 0, // 融资余额 (元)
    financeNetBuy: r.RZJME ?? 0, // 融资净买入 (元)
    secLendingBalance: r.RQYE ?? 0, // 融券余额 (元)
    financeBalanceRatio: r.RZYEZB ?? null, // 占流通市值比
    closePrice: r.SPJ ?? null,
    changePct: r.ZDF ?? null,
  }));
}

// 龙虎榜
export async function fetchLhb(stock) {
  const filter = `(SECURITY_CODE="${stock.code}")`;
  const rows = await eastmoneyReport('RPT_DAILYBILLBOARD_DETAILS', filter, {
    pageSize: 5,
    sortColumns: 'TRADE_DATE',
  });
  return rows.map((r) => ({
    code: stock.code,
    tradeDate: String(r.TRADE_DATE || '').slice(0, 10),
    closePrice: r.CLOSE_PRICE,
    changeRate: r.CHANGE_RATE,
    turnoverRate: r.TURNOVERRATE,
    explanation: r.EXPLANATION || '', // 上榜原因
    buyAmount: r.BILLBOARD_BUY_AMT ?? 0,
    sellAmount: r.BILLBOARD_SELL_AMT ?? 0,
    netAmount: r.BILLBOARD_NET_AMT ?? 0,
  }));
}

// 大宗交易
export async function fetchBlockTrade(stock) {
  const filter = `(SECURITY_CODE="${stock.code}")`;
  const rows = await eastmoneyReport('RPT_DATA_BLOCKTRADE', filter, {
    pageSize: 5,
    sortColumns: 'TRADE_DATE',
  });
  return rows.map((r) => ({
    code: stock.code,
    tradeDate: String(r.TRADE_DATE || '').slice(0, 10),
    dealPrice: r.DEAL_PRICE,
    premiumRatio: r.PREMIUM_RATIO, // 折溢价率
    dealVolume: r.DEAL_VOLUME,
    dealAmount: r.DEAL_AMT,
    buyer: r.BUYER_NAME || '',
    seller: r.SELLER_NAME || '',
  }));
}

// 资金流向（东财 push2his 官方历史时序接口，稳定获取多日主力资金净额）
export async function fetchFundFlow(stock, limitDays = 30) {
  const secid = eastmoneySecId(stock);
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=${limitDays}&klt=101&secid=${secid}` +
    `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`;
  
  let txt;
  try {
    txt = await httpGet(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Referer: 'https://quote.eastmoney.com/',
      },
      timeout: 12000,
    });
  } catch {
    return null;
  }

  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    return null;
  }

  const klines = json?.data?.klines || [];
  if (klines.length === 0) return null;

  // 解析所有返回的天数
  const list = klines.map((item) => {
    const f = item.split(',');
    return {
      code: stock.code,
      date: f[0],
      mainNet: parseFloat(f[1]) || 0, // 主力净额（元）
      smallNet: parseFloat(f[2]) || 0,
      midNet: parseFloat(f[3]) || 0,
      largeNet: parseFloat(f[4]) || 0,
      superLargeNet: parseFloat(f[5]) || 0,
    };
  });

  return {
    latest: list[list.length - 1],
    history: list,
  };
}
